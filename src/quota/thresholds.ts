/**
 * Quota threshold push warnings (push spec §5.7, requested 2026-10-01):
 * the 5-hour and weekly windows each notify ONCE per tier — 60% used, 80%
 * used, 90% used, 95% used, 98% used, exhausted — edge-triggered on a
 * refresh DISCOVERING the first crossing (never level-triggered, precision
 * explicitly not required).
 *
 * Every fresh `queryQuota()` fetch funnels through here (the martty dock
 * refresher's 60s cadence + turn-end forceRefresh, the hub's dock cache,
 * `/quota`, the settings REST routes), so wherever quota data materializes,
 * thresholds are watched. A drop below 60 re-arms the tiers (new window,
 * reset card, weekly rollover).
 *
 * The per-key highest-notified tier is PERSISTED next to the user config
 * (`quota-push-state.json`) under the SHARED FILE LOCK, re-read from disk on
 * EVERY check: several processes observe the same crossing (observed live
 * 2026-10-14: one "5h quota 60% used" delivered three times — hub + bridges,
 * two of them 80ms apart). A per-process in-memory mirror cannot dedupe
 * across processes: a bridge that booted before the hub persisted a tier
 * keeps its stale mirror forever and pushes the same crossing again. The
 * lock makes read→advance→persist atomic between processes, and the push
 * fires only AFTER the advanced state is durable — a crash between the two
 * never re-pushes. The state advances even when the push itself is switched
 * off or suppressed, so re-enabling never replays old crossings. Everything
 * here is fire-and-forget from the caller's view: failures warn, never throw.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { userConfigPath } from "../config/user-config.js";
import { pushActive } from "../push/config.js";
import { pushQuotaWarning } from "../push/push.js";
import { readJsonDocument } from "../settings/atomic-write.js";
import { withFileLock } from "../settings/file-lock.js";
import { warn } from "../utils.js";
import type { QuotaItem, QuotaResult } from "./types.js";

/** Windows that count as budget alarms (keys from parse.ts). */
const WATCHED_KEYS = new Set(["token_5h", "token_week"]);

/** Notify tiers in percent: 60 / 80 / 90 / 95 / 98 / exhausted (100). */
const TIERS = [60, 80, 90, 95, 98, 100] as const;

/** Window display name for the push title. */
function windowName(item: QuotaItem): string {
  return item.key === "token_week" ? "weekly" : item.label.toLowerCase();
}

/** Highest tier crossed by a used percentage (0 = below all). */
export function quotaTier(usedPercent: number): number {
  let tier = 0;
  for (const t of TIERS) if (usedPercent >= t) tier = t;
  return tier;
}

function statePath(): string {
  return path.join(path.dirname(userConfigPath()), "quota-push-state.json");
}

async function loadState(): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  try {
    const doc = await readJsonDocument(statePath());
    const items = (doc ?? {})["items"];
    if (typeof items === "object" && items !== null && !Array.isArray(items)) {
      for (const key of WATCHED_KEYS) {
        const v = (items as Record<string, unknown>)[key];
        if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100) {
          map.set(key, v);
        }
      }
    }
  } catch {
    // Absent or unreadable — starts re-armed; never fatal.
  }
  return map;
}

/**
 * Persist the tiers (temp+rename). Lock-FREE on purpose: the caller already
 * holds the state file's lock, and `writeJsonAtomic` takes the same lock
 * itself — nesting the two deadlocks on the in-process FIFO (observed as an
 * 8s lock timeout in tests). Mirrors quota-resume's `writeTable`.
 *
 * @returns false when the write did not stick — the caller then skips the
 *          pushes (state must be durable BEFORE the notification fires, or
 *          the next funnel replays the crossing).
 */
function persist(map: Map<string, number>): boolean {
  try {
    const p = statePath();
    mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ items: Object.fromEntries(map) }, null, 2)}\n`, "utf8");
    renameSync(tmp, p);
    return true;
  } catch (e) {
    warn(`quota-thresholds: state persist failed (${e instanceof Error ? e.message : String(e)})`);
    return false;
  }
}

/**
 * Check one fresh quota result against the persisted tiers and push each
 * newly-crossed tier once. Callers fire-and-forget this; it never throws.
 *
 * The read→advance→persist section runs under the shared file lock on the
 * state file (re-reading disk every check): hub + bridges all funnel quota
 * results, and without the lock two processes observe one crossing
 * concurrently and each pushes it. The push fires after the lock releases,
 * so a crash between persist and send never replays the crossing.
 */
export async function checkQuotaThresholds(result: QuotaResult): Promise<void> {
  // Without push there is nothing to notify and no state worth maintaining —
  // a later activation starts re-armed instead of replaying old crossings.
  if (!pushActive()) return;
  if (result.kind !== "success") return;
  const toPush: Array<{ title: string; body?: string }> = [];
  try {
    await withFileLock(statePath(), async () => {
      const st = await loadState();
      let dirty = false;
      let persisted = true;
      for (const item of result.items) {
        if (!WATCHED_KEYS.has(item.key)) continue;
        const tier = quotaTier(item.usedPercent);
        const prev = st.get(item.key) ?? 0;
        if (tier === 0) {
          // Usage dropped below the first tier — new window / reset card: re-arm.
          if (prev !== 0) {
            st.delete(item.key);
            dirty = true;
          }
          continue;
        }
        if (tier <= prev) continue;
        st.set(item.key, tier);
        dirty = true;
        const name = windowName(item);
        toPush.push({
          title:
            tier === 100
              ? `${name} quota exhausted`
              : `${name} quota ${Math.round(item.usedPercent)}% used`,
          body: item.nextResetTime
            ? `resets ${new Date(item.nextResetTime).toLocaleString()}`
            : undefined,
        });
      }
      if (dirty) persisted = persist(st);
      if (!persisted) toPush.length = 0;
    });
  } catch (e) {
    // Lock timeout or IO failure — skip this round; the next funnel (the dock
    // refresher's 60s cadence) retries with the same crossing.
    warn(`quota-thresholds: check failed (${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  for (const n of toPush) {
    pushQuotaWarning({ kind: "quota", title: n.title, body: n.body });
  }
}

/** Test hook: no in-process mirror remains (disk is re-read every check) —
 *  kept for call-site compatibility; the disk state is the only state. */
export function resetQuotaThresholdsForTest(): void {}
