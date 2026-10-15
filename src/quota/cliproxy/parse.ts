/**
 * Parsers for the two CLIProxyAPI response shapes. Both are reconstructed
 * from the v8.0.28 source + CPAMC web-UI readers (undocumented on the wire) —
 * every field is read defensively: missing/odd shapes degrade to empty, never
 * throw. The management API accepts both camelCase and snake_case INPUT, but
 * its OUTPUT spelling is not contractual, so both variants are read.
 */

import type { CpModelQuota, CpWindow, CpWindowQuota } from "./types.js";

/** Antigravity accounts' provider id in the credentials listing (CPAMC's own
 *  quota support is antigravity-only — there is no separate gemini provider). */
export const ANTIGRAVITY_PROVIDER = "antigravity";

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A parsed credential entry — only the fields the quota flow needs. */
export interface CpCredentialEntry {
  authIndex: string;
  provider: string;
  label: string;
  projectId?: string;
}

/**
 * Parse the credentials listing. The response is an array of entries (the
 * field-carrying object may nest one level under `auth_files`/`credentials`/
 * `files` on some builds), each with `auth_index`/`authIndex` and
 * `provider`. The Gemini quota relay needs the account's CloudCode project
 * id: `file.project_id` → `metadata` → `attributes` → the entry itself
 * (CPAMC's resolution ladder).
 */
export function parseCredentialEntries(text: string): CpCredentialEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  let arr: unknown[] | null = Array.isArray(parsed) ? parsed : null;
  if (!arr) {
    const doc = asRecord(parsed);
    if (doc) {
      for (const key of ["auth_files", "credentials", "files", "data"]) {
        if (Array.isArray(doc[key])) {
          arr = doc[key] as unknown[];
          break;
        }
      }
    }
  }
  if (!arr) return [];
  const entries: CpCredentialEntry[] = [];
  for (const raw of arr) {
    const e = asRecord(raw);
    if (!e) continue;
    const authIndex = str(e.auth_index ?? e.authIndex ?? e.id);
    const provider = str(e.provider ?? e.type) ?? "";
    if (!authIndex) continue;
    const file = asRecord(e.file);
    const metadata = asRecord(e.metadata);
    const attributes = asRecord(e.attributes);
    const email =
      str(file?.email) ?? str(metadata?.email) ?? str(attributes?.email) ?? str(e.email);
    entries.push({
      authIndex,
      provider,
      label: email ? email.split("@")[0]! : authIndex,
      projectId:
        str(file?.project_id ?? file?.projectId) ??
        str(metadata?.project_id ?? metadata?.projectId) ??
        str(attributes?.project_id ?? attributes?.projectId) ??
        str(e.project_id ?? e.projectId),
    });
  }
  return entries;
}

/**
 * Parse one relayed `retrieveUserQuotaSummary` body into per-family windowed
 * rows.
 *
 * Shape (live-verified 2026-10, CPAMC `builders.ts`): `{groups: [{displayName,
 * buckets: [{window, remainingFraction, resetTime, …}]}]}` — each group is a
 * model family ("Gemini Models", "Claude and GPT models") with one bucket per
 * window. Bucket `window` spellings normalize to `5h` / `week` (CPAMC's
 * accepted spellings); buckets with an unknown window or an out-of-range
 * fraction are dropped. Multiple buckets sharing a window keep the TIGHTEST.
 * Missing/odd fields degrade to empty, never throw.
 */
export function parseQuotaSummary(bodyText: string): CpModelQuota[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return [];
  }
  const doc = asRecord(parsed);
  if (!doc || !Array.isArray(doc.groups)) return [];
  const models: CpModelQuota[] = [];
  for (const [index, gRaw] of doc.groups.entries()) {
    const g = asRecord(gRaw);
    if (!g) continue;
    const name = str(g.displayName ?? g.display_name) ?? `Quota Group ${index + 1}`;
    // window → tightest bucket seen for it
    const tightest = new Map<CpWindow, { used: number; resetAt?: number }>();
    if (Array.isArray(g.buckets)) {
      for (const bRaw of g.buckets) {
        const b = asRecord(bRaw);
        if (!b) continue;
        const window = windowOf(b.window);
        if (window === null) continue;
        const remaining = num(b.remainingFraction ?? b.remaining_fraction);
        if (remaining === undefined || remaining < 0 || remaining > 1) continue;
        const used = 1 - remaining;
        const prev = tightest.get(window);
        if (prev && prev.used >= used) continue;
        const resetRaw = str(b.resetTime ?? b.reset_time);
        const resetAt = resetRaw !== undefined ? Date.parse(resetRaw) : Number.NaN;
        tightest.set(window, {
          used,
          ...(Number.isFinite(resetAt) && { resetAt }),
        });
      }
    }
    if (tightest.size === 0) continue;
    models.push({ name, windows: orderWindows(tightest) });
  }
  return models;
}

/** Bucket window spellings → canonical window (mirrors CPAMC's
 *  `antigravityPeriodHours` accepted spellings; anything else is dropped). */
function windowOf(raw: unknown): CpWindow | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "5h" || v === "five-hour" || v === "five_hour") return "5h";
  if (v === "weekly" || v === "week") return "week";
  return null;
}

function orderWindows(tightest: Map<CpWindow, { used: number; resetAt?: number }>): CpWindowQuota[] {
  const out: CpWindowQuota[] = [];
  for (const window of ["5h", "week"] as const) {
    const hit = tightest.get(window);
    if (hit) out.push({ window, ...hit });
  }
  return out;
}

/** Convenience: the relay envelope's upstream status (200 unless malformed). */
export function relayUpstreamStatus(text: string): number {
  try {
    const doc = asRecord(JSON.parse(text));
    return num(doc?.status_code ?? doc?.statusCode) ?? 200;
  } catch {
    return 200;
  }
}

/** Convenience: the relay envelope's upstream body (a STRING inside). */
export function relayUpstreamBody(text: string): string | undefined {
  try {
    const doc = asRecord(JSON.parse(text));
    return str(doc?.body);
  } catch {
    return undefined;
  }
}

export type { CpModelQuota, CpWindow, CpWindowQuota };
