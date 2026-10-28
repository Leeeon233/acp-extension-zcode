/**
 * Account-level usage stats — Proposal 0002 (`account/usage_stats`).
 *
 * Exposes the combined dual-provider quota behind the `zcode-acp quota` CLI
 * (GLM Coding Plan + Opencode Go) to remote clients as a pull-only ACP
 * method, callable any time after `initialize` (no session required — quota
 * is account-level, so it fits no `session/update` kind).
 *
 * The response mirrors the CLI card's data model so clients can reproduce it
 * exactly: one GLM section (plan level + per-window items with per-model
 * details), one Opencode Go section (rolling/weekly/monthly windows, the
 * relative reset countdown converted to an absolute timestamp), one Ollama
 * Cloud section (session/weekly/monthly fractions as percents, with the
 * derived reset moments when available — the API itself returns none), and
 * one CLIProxy section (per-Gemini-account per-model usage fractions as
 * percents with reset moments). Provider failures are reported per-section as
 * `kind` strings rather than throwing — the client renders the same status
 * line the CLI would (a `not_configured` section is simply omitted, matching
 * the CLI).
 */

import { parseRemoteConfig } from "../remote/config.js";
import { aggregateCpFamilies, combinedCpWindows } from "../quota/cliproxy/aggregate.js";
import type { CpFamilyWindow } from "../quota/cliproxy/aggregate.js";
import type { CpQueryResult } from "../quota/cliproxy/types.js";
import { queryCombined } from "../quota/combined.js";
import type { OcQueryResult } from "../quota/ollama-cloud/types.js";
import type { GoQueryResult, GoWindowKey } from "../quota/opencode-go/types.js";
import type { QuotaItem, QuotaResult } from "../quota/types.js";

/** GLM section — `items` present only on success. */
export interface GlmUsageStats {
  kind: QuotaResult["kind"];
  level?: string;
  items?: QuotaItem[];
}

/** One Opencode Go window with the reset countdown resolved to epoch ms. */
export interface GoWindowEntry {
  key: GoWindowKey;
  label: string;
  usagePercent: number;
  resetsAt: number;
}

/** Opencode Go section — `windows` present only on success. */
export interface GoUsageStats {
  kind: GoQueryResult["kind"];
  windows?: GoWindowEntry[];
}

/**
 * One Ollama Cloud window with the derived reset moment (epoch ms) when
 * available — the API returns no timestamps, so resets are computed at query
 * time (window anchoring, or /api/me's billing period for monthly).
 */
export interface OcWindowEntry {
  key: "session" | "weekly" | "monthly";
  label: string;
  usagePercent: number;
  resetsAt?: number;
}

/**
 * Ollama Cloud spend detail (analytics API, 2026-10+): usage in USD over the
 * rolling 30d window. `creditUsd` is present only when the plan's monthly
 * credit is known (pricing table) — which is also what makes the `monthly`
 * percent window derivable; without it the client can still render the raw
 * spend. Additive field: older clients ignore it.
 */
export interface OcUsageDetail {
  plan?: string;
  usageUsd: number;
  creditUsd?: number;
  requestCount?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  /** The rolling window the spend covers — the API offers no billing-period
   *  range, so the monthly percent is this window ÷ credit (approximation). */
  window: "30d";
}

/** Ollama Cloud section — `windows` present only on success. */
export interface OcUsageStats {
  kind: OcQueryResult["kind"];
  windows?: OcWindowEntry[];
  usage?: OcUsageDetail;
}

/** One window of one CLIProxy Gemini model family: usage fraction as percent. */
export interface CpWindowEntry {
  window: "5h" | "week";
  usedPercent: number;
  resetsAt?: number;
}

/** One CLIProxy Gemini model family and its per-window usage. */
export interface CpModelEntry {
  name: string;
  windows: CpWindowEntry[];
}

/** One CLIProxy Gemini account and its per-family usage. */
export interface CpAccountEntry {
  label: string;
  models: CpModelEntry[];
}

/**
 * CLIProxy section — `accounts` (per-subscription detail) and `combined`
 * (pool-wide per-window rows across all subscriptions, the numbers the CLI
 * card renders) present only on success, plus the count of non-Gemini
 * accounts the proxy routes (informational tail for clients).
 */
export interface CpUsageStats {
  kind: CpQueryResult["kind"];
  accounts?: CpAccountEntry[];
  combined?: CpWindowEntry[];
  otherAccounts?: number;
}

export interface UsageStatsResult {
  glm: GlmUsageStats;
  opencode: GoUsageStats;
  ollama: OcUsageStats;
  cliproxy: CpUsageStats;
}

/** Window labels matching the CLI's card (`5h` / `Week` / `Month`). */
const GO_WINDOW_LABELS: Record<GoWindowKey, string> = {
  rolling: "5h",
  weekly: "Week",
  monthly: "Month",
};

/** GLM items pass through verbatim — the client renders the CLI layout. */
function toGlmStats(result: QuotaResult): GlmUsageStats {
  if (result.kind !== "success") return { kind: result.kind };
  return { kind: "success", level: result.level, items: result.items };
}

/**
 * Go windows with the same absolute-reset math the CLI formatter uses:
 * subtract the elapsed time since the fetch snapshot from `resetInSec`.
 */
function toGoStats(result: GoQueryResult, now = Date.now()): GoUsageStats {
  if (result.kind !== "success") return { kind: result.kind };
  const elapsedSec = Math.max(0, (now - result.fetchedAt) / 1000);
  const windows = (["rolling", "weekly", "monthly"] as const).flatMap((key) => {
    const w = result[key];
    if (!w) return [];
    const remainingSec = Math.max(0, w.resetInSec - elapsedSec);
    return [
      {
        key,
        label: GO_WINDOW_LABELS[key],
        usagePercent: w.usagePercent,
        resetsAt: result.fetchedAt + remainingSec * 1000,
      },
    ];
  });
  return { kind: "success", windows };
}

/**
 * Ollama windows as percents — the API's 0..1 fractions converted once here
 * so remote clients can render the same bar the CLI does. Which windows exist
 * depends on the plan (legacy: session+weekly; credit: monthly, derived from
 * 30d spend ÷ plan credit). The derived reset moments and the analytics spend
 * detail pass through when present.
 */
function toOcStats(result: OcQueryResult): OcUsageStats {
  if (result.kind !== "success") return { kind: result.kind };
  const LABELS = { session: "5h", weekly: "Week", monthly: "Month" } as const;
  const RESETS = {
    session: "sessionResetAt",
    weekly: "weeklyResetAt",
    monthly: "monthlyResetAt",
  } as const;
  const windows = (["session", "weekly", "monthly"] as const).flatMap((key) => {
    if (result[key] === undefined) return [];
    const reset = result[RESETS[key]];
    return [
      {
        key,
        label: LABELS[key],
        usagePercent: result[key]! * 100,
        ...(typeof reset === "number" && { resetsAt: reset }),
      },
    ];
  });
  const usage =
    result.usageUsd !== undefined
      ? {
          ...(result.plan !== undefined && { plan: result.plan }),
          usageUsd: result.usageUsd,
          ...(result.creditUsd !== undefined && { creditUsd: result.creditUsd }),
          ...(result.requestCount !== undefined && { requestCount: result.requestCount }),
          ...(result.inputTokens !== undefined && { inputTokens: result.inputTokens }),
          ...(result.cachedInputTokens !== undefined && {
            cachedInputTokens: result.cachedInputTokens,
          }),
          ...(result.outputTokens !== undefined && { outputTokens: result.outputTokens }),
          window: "30d" as const,
        }
      : undefined;
  return { kind: "success", windows, ...(usage !== undefined && { usage }) };
}

/** CLIProxy windows pass through with the 0..1 fraction converted to percent. */
function toCpWindowEntries(windows: CpFamilyWindow[]): CpWindowEntry[] {
  return windows.map((w) => ({
    window: w.window,
    usedPercent: w.used * 100,
    ...(w.resetAt !== undefined && { resetsAt: w.resetAt }),
  }));
}

/** CLIProxy stats: per-account detail plus the pool-wide combined rows. */
function toCpStats(result: CpQueryResult, otherCount: number): CpUsageStats {
  if (result.kind !== "success") return { kind: result.kind };
  const families = aggregateCpFamilies(result.accounts);
  return {
    kind: "success",
    accounts: result.accounts.map((account) => ({
      label: account.label,
      models: account.models.map((model) => ({
        name: model.name,
        windows: toCpWindowEntries(model.windows),
      })),
    })),
    combined: toCpWindowEntries(combinedCpWindows(families)),
    ...(otherCount > 0 && { otherAccounts: otherCount }),
  };
}

/** `account/usage_stats` handler — all providers, queried in parallel. */
export async function accountUsageStats(): Promise<UsageStatsResult> {
  const { glm, go, oc, cp, cpOtherCount } = await queryCombined("all");
  return {
    glm: toGlmStats(glm),
    opencode: toGoStats(go),
    ollama: toOcStats(oc),
    cliproxy: toCpStats(cp, cpOtherCount),
  };
}

/**
 * Budget for the hub-first lookup in {@link accountUsageStatsViaHub}. Longer
 * than the dock's 500ms (live.ts): this answers an explicit client request,
 * and the hub's own cache may be cold — better to wait than to fire a second
 * full provider sweep in this process. A down hub still falls back instantly
 * (loopback connect-refused), so the budget only ever waits on a live hub.
 */
const HUB_QUOTA_BUDGET_MS = 2_000;

/**
 * Hub-first `account/usage_stats` — quota traffic converges on the hub's
 * cache whenever one exists (same policy as the dock refresher, live.ts), so
 * many clients/bridges translate to one upstream sweep per TTL window. Any
 * failure (no remote config, hub down, budget exceeded) falls back to the
 * local {@link accountUsageStats} — the normal path for local-only setups.
 */
export async function accountUsageStatsViaHub(
  env: NodeJS.ProcessEnv = process.env,
): Promise<UsageStatsResult> {
  const remote = parseRemoteConfig(env);
  if (remote) {
    try {
      const resp = await fetch(`http://${remote.hubHost}:${remote.hubPort}/api/quota`, {
        headers: { Authorization: `Bearer ${remote.token}` },
        signal: AbortSignal.timeout(HUB_QUOTA_BUDGET_MS),
      });
      if (resp.ok) {
        const body = (await resp.json()) as Partial<UsageStatsResult>;
        // Require the `cliproxy` section too: an older hub without it would
        // silently hide the section from clients. The hub auto-upgrades onto
        // the current dist, so the skew window is short; meanwhile a local
        // query keeps the answer complete.
        if (body.glm && body.cliproxy) return body as UsageStatsResult;
      }
    } catch {
      // hub absent/restarting — local fallback below
    }
  }
  return accountUsageStats();
}
