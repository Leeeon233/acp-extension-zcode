/**
 * Ollama Cloud usage orchestration — the entry point used by the
 * `zcode-acp quota` CLI.
 *
 * Flow: credential (env + config file) → cache check → fetch → status/auth
 * check → parse → cache write. Any thrown error degrades to `unavailable`
 * rather than propagating, so the CLI always produces output.
 *
 * A missing API key yields `not_configured`, which the combined view silently
 * skips — so users who only care about GLM see no noise.
 */

import { log } from "../../utils.js";
import { getCached, setCached } from "./cache.js";
import { loadApiKey } from "./config.js";
import { fetchOcMe, fetchOcUsage } from "./client.js";
import type { OcQueryResult } from "./types.js";

/** Session window length: a rolling 5h bucket anchored at the Unix epoch. */
export const SESSION_WINDOW_MS = 5 * 3_600_000;
/** Weekly window anchor: Monday 00:00 UTC (the epoch was a Thursday, so the
 *  first Monday sits 4 days in) — same inference as the pi-multi-account
 *  reference client. */
export const WEEK_ANCHOR_MS = 4 * 86_400_000;
const WEEK_MS = 7 * 86_400_000;

/**
 * Next reset of the epoch-aligned 5h session bucket strictly after `t`.
 * The anchoring is inferred from observed bucket behaviour (undocumented).
 */
export function nextSessionReset(t: number): number {
  return (Math.floor(t / SESSION_WINDOW_MS) + 1) * SESSION_WINDOW_MS;
}

/** Next Monday 00:00 UTC strictly after `t` (the weekly window reset). */
export function nextWeeklyReset(t: number): number {
  const next = WEEK_ANCHOR_MS + (Math.floor((t - WEEK_ANCHOR_MS) / WEEK_MS) + 1) * WEEK_MS;
  return next > t ? next : next + WEEK_MS;
}

/**
 * Best-effort monthly reset lookup via POST /api/me. Two shapes exist:
 * - `SubscriptionPeriodEnd` (Go `sql.NullTime` `{Time, Valid}`) — the billing
 *   period end, when the account carries one;
 * - `CreatedAt` — the subscription start. New credit plans (live-verified
 *   2026-09-17: a Pro account returns only ID/CreatedAt/Email/Name/Plan, no
 *   SubscriptionPeriodEnd) reset monthly on the subscription day, so the
 *   reset is the next monthly anniversary of that timestamp.
 * Also carries the `Plan` id — the key into {@link PLAN_CREDIT_USD}. Any
 * failure (network, auth, shape) yields empty fields — the caller then
 * renders without the reset stamp / derived percent.
 *
 * `periodStartAt` is the START of the CURRENT billing period (the last reset
 * that already happened) — the anchor for the bucket-summed period spend.
 */
interface OcAccountInfo {
  plan?: string;
  monthlyResetAt?: number;
  periodStartAt?: number;
}

async function lookupAccountInfo(apiKey: string): Promise<OcAccountInfo> {
  try {
    const resp = await fetchOcMe(apiKey);
    if (resp.status !== 200) return {};
    const parsed = JSON.parse(resp.text) as Record<string, unknown>;
    const info: OcAccountInfo = {};
    const planRaw = parsed.Plan ?? parsed.plan;
    if (typeof planRaw === "string" && planRaw.length > 0) info.plan = planRaw;
    const period = parsed.SubscriptionPeriodEnd ?? parsed.subscriptionPeriodEnd;
    if (period !== undefined) {
      const raw =
        (period as { Time?: unknown; time?: unknown }).Time ?? (period as { time?: unknown }).time;
      const valid =
        (period as { Valid?: unknown; valid?: unknown }).Valid ??
        (period as { valid?: unknown }).valid;
      if (valid !== false && typeof raw === "string") {
        const ms = Date.parse(raw);
        if (Number.isFinite(ms)) {
          info.monthlyResetAt = ms;
          // The billing period runs up TO the (future) period end; its start
          // sits one month earlier, clamped to that month's last day.
          if (ms > Date.now()) info.periodStartAt = subtractOneMonthClamped(ms);
        }
      }
    }
    if (info.monthlyResetAt === undefined) {
      const createdRaw = parsed.CreatedAt ?? parsed.createdAt;
      if (typeof createdRaw === "string") {
        const created = Date.parse(createdRaw);
        if (Number.isFinite(created)) {
          const now = Date.now();
          info.monthlyResetAt = nextMonthlyAnniversary(created, now);
          const start = prevMonthlyAnniversary(created, now);
          if (Number.isFinite(start)) info.periodStartAt = start;
        }
      }
    }
    return info;
  } catch {
    return {};
  }
}

/**
 * Monthly usage credit per plan (USD) — ollama.com/pricing as of 2026-10-10
 * (Pro $60, Max $300, Team $1000). The usage API no longer reports any limit,
 * so the plan id from POST /api/me keys this table to derive the monthly
 * percent (30d spend ÷ credit). Free's "starter credits" amount is unlisted
 * → no percent for unknown plans, spend only. Prices can drift when Ollama
 * reprices — re-check the pricing page when the percent looks wrong.
 */
export const PLAN_CREDIT_USD: Record<string, number> = {
  pro: 60,
  max: 300,
  team: 1000,
};

/**
 * Next monthly anniversary of `createdMs` strictly after `now` — new credit
 * plans reset monthly on the subscription day, so the anchor keeps the
 * subscription's UTC time-of-day, not a made-up midnight. The day clamps to
 * the target month's length (a 31st signup rolls to the 30th/28th).
 */
export function nextMonthlyAnniversary(createdMs: number, now: number): number {
  const created = new Date(createdMs);
  const nowDate = new Date(now);
  const day = created.getUTCDate();
  const h = created.getUTCHours();
  const min = created.getUTCMinutes();
  const sec = created.getUTCSeconds();
  const ms = created.getUTCMilliseconds();
  for (let year = nowDate.getUTCFullYear(); year <= nowDate.getUTCFullYear() + 1; year++) {
    for (
      let month = year === nowDate.getUTCFullYear() ? nowDate.getUTCMonth() : 0;
      month < 12;
      month++
    ) {
      // Clamp to the month's last day (UTC months are 0-based).
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const candidate = Date.UTC(year, month, Math.min(day, lastDay), h, min, sec, ms);
      if (candidate > now) return candidate;
    }
  }
  return Number.NaN;
}

/**
 * Latest monthly anniversary of `createdMs` at or before `now` (NaN when none
 * exists — e.g. a malformed future-dated creation). The START of the current
 * billing period; together with {@link nextMonthlyAnniversary} it brackets
 * [periodStart, nextReset).
 */
export function prevMonthlyAnniversary(createdMs: number, now: number): number {
  const created = new Date(createdMs);
  const nowDate = new Date(now);
  if (Number.isNaN(created.getTime()) || Number.isNaN(nowDate.getTime())) return Number.NaN;
  const day = created.getUTCDate();
  const h = created.getUTCHours();
  const min = created.getUTCMinutes();
  const sec = created.getUTCSeconds();
  const ms = created.getUTCMilliseconds();
  let best = Number.NaN;
  for (let year = nowDate.getUTCFullYear() - 1; year <= nowDate.getUTCFullYear(); year++) {
    for (let month = 0; month < 12; month++) {
      // Clamp to the month's last day (UTC months are 0-based).
      const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      const candidate = Date.UTC(year, month, Math.min(day, lastDay), h, min, sec, ms);
      if (candidate <= now && (Number.isNaN(best) || candidate > best)) best = candidate;
    }
  }
  return best;
}

/**
 * One month before `ms`, clamped to the previous month's last day (a Mar-31
 * period end clamps its start to Feb 28/29). `Date.UTC` normalizes
 * `month - 1`, so January flows into December of the previous year.
 */
export function subtractOneMonthClamped(ms: number): number {
  const d = new Date(ms);
  const lastDayOfPrev = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).getUTCDate();
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth() - 1,
    Math.min(d.getUTCDate(), lastDayOfPrev),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}

/** A raw daily bucket from the analytics response (keys observed 2026-10). */
export interface OcUsageBucket {
  from?: unknown;
  until?: unknown;
  usage_usd?: unknown;
  request_count?: unknown;
}

/** Spend summed from the daily buckets over the current billing period. */
export interface OcPeriodSpend {
  usageUsd: number;
  requestCount?: number;
}

/**
 * Sum the daily buckets' spend over `[periodStartAt, ∞)` — the honest monthly
 * numerator: a reset empties the window instead of keeping the rolling-30d
 * spend (observed 2026-10-14: 81% shown two days past the reset vs 1.4%
 * actual). The bucket straddling the period start is split proportionally by
 * its time overlap (day granularity is all the API offers).
 *
 * Returns `undefined` — the caller then falls back to the rolling-30d
 * `totals.usage_usd` — when no `periodStartAt` is known, no bucket parses, or
 * the buckets do not reach back to the period start (the 30d window opens up
 * to a day later than a monthly period start, so the tail day of the period
 * can sit outside the response).
 */
export function periodSpend(
  buckets: OcUsageBucket[],
  periodStartAt: number | undefined,
): OcPeriodSpend | undefined {
  if (periodStartAt === undefined || !Number.isFinite(periodStartAt) || buckets.length === 0) {
    return undefined;
  }
  let usageUsd = 0;
  let requestCount = 0;
  let anyUsage = false;
  let anyRequest = false;
  let minFrom = Number.POSITIVE_INFINITY;
  for (const raw of buckets) {
    const from = typeof raw.from === "string" ? Date.parse(raw.from) : Number.NaN;
    const until = typeof raw.until === "string" ? Date.parse(raw.until) : Number.NaN;
    if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) continue;
    minFrom = Math.min(minFrom, from);
    if (until <= periodStartAt) continue; // entirely before the period
    // Fraction of the bucket inside the period (the reset-day straddler).
    const frac = from >= periodStartAt ? 1 : (until - periodStartAt) / (until - from);
    if (validCount(raw.usage_usd)) {
      usageUsd += (raw.usage_usd as number) * frac;
      anyUsage = true;
    }
    if (validCount(raw.request_count)) {
      requestCount += (raw.request_count as number) * frac;
      anyRequest = true;
    }
  }
  // Coverage: the earliest usable bucket must sit at/before the period start,
  // else the sum silently undercounts the period's first day(s).
  if (!anyUsage || minFrom > periodStartAt) return undefined;
  return {
    usageUsd,
    ...(anyRequest && { requestCount: Math.round(requestCount) }),
  };
}

/**
 * Validate a usage value from the legacy response body: a finite number in
 * [0, 1].
 *
 * Values > 1 are rejected on purpose: the endpoint is undocumented, and if
 * Ollama ever switches to percent-valued numbers, silently treating 42 as a
 * 4200% fraction would render a nonsensical full bar. The same guard is used
 * by the pi-multi-account reference client.
 */
function validFraction(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/** A finite non-negative counter/money value from the analytics `totals`. */
function validCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Query Ollama Cloud usage and return a normalised {@link OcQueryResult}.
 *
 * - No key → `not_configured`.
 * - Serves a cached result when fresh (< 10s).
 * - HTTP 401/403 → `auth_error` (bad or revoked key).
 * - Network/timeout/parse failure → `unavailable`.
 *
 * Response shapes (first match wins):
 * - analytics (2026-10+): `totals.usage_usd` over the requested 30d window →
 *   spend detail + derived `monthly` fraction (spend ÷ plan credit; the /api/me
 *   lookup supplies both the plan and the reset moment);
 * - legacy limits (pre-2026-10): `limits.{session,weekly,monthly}.usage`
 *   fractions as-is.
 */
export async function queryOcUsage(): Promise<OcQueryResult> {
  const cached = getCached();
  if (cached) {
    log("ollama-cloud: serving cached result");
    return cached;
  }

  const apiKey = loadApiKey();
  if (!apiKey) return { kind: "not_configured" };

  let result: OcQueryResult;
  try {
    const resp = await fetchOcUsage(apiKey);

    if (resp.status === 401 || resp.status === 403) {
      result = { kind: "auth_error" };
    } else if (resp.status !== 200) {
      // 429 = quota exhausted, 5xx = server-side; neither is a usage snapshot.
      log(`ollama-cloud: unexpected status ${resp.status}`);
      result = { kind: "unavailable" };
    } else {
      const parsed = JSON.parse(resp.text) as {
        totals?: Record<string, unknown>;
        limits?: Record<string, { usage?: unknown } | undefined>;
        buckets?: unknown;
      };
      const totals = parsed.totals ?? {};
      const usageUsd = validCount(totals.usage_usd) ? totals.usage_usd : undefined;
      if (usageUsd !== undefined) {
        // Analytics shape: spend over the rolling 30d window. The monthly
        // percent prefers the bucket-summed CURRENT-PERIOD spend (reset-aware)
        // and falls back to the rolling total only when the buckets cannot
        // bracket the period (no /api/me period, no coverage — see
        // {@link periodSpend}).
        const fetchedAt = Date.now();
        const { plan, monthlyResetAt, periodStartAt } = await lookupAccountInfo(apiKey);
        const creditUsd = plan !== undefined ? PLAN_CREDIT_USD[plan.toLowerCase()] : undefined;
        const buckets: OcUsageBucket[] = Array.isArray(parsed.buckets)
          ? (parsed.buckets as OcUsageBucket[])
          : [];
        const period = periodSpend(buckets, periodStartAt);
        const monthlyNumerator = period !== undefined ? period.usageUsd : usageUsd;
        result = {
          kind: "success",
          ...(creditUsd !== undefined && { monthly: Math.min(1, monthlyNumerator / creditUsd) }),
          ...(monthlyResetAt !== undefined && { monthlyResetAt }),
          usageUsd,
          ...(period !== undefined &&
            periodStartAt !== undefined && {
              periodUsageUsd: period.usageUsd,
              periodStartAt,
              ...(period.requestCount !== undefined && { periodRequestCount: period.requestCount }),
            }),
          ...(plan !== undefined && { plan }),
          ...(creditUsd !== undefined && { creditUsd }),
          ...(validCount(totals.request_count) && { requestCount: totals.request_count }),
          ...(validCount(totals.input_tokens) && { inputTokens: totals.input_tokens }),
          ...(validCount(totals.cached_input_tokens) && {
            cachedInputTokens: totals.cached_input_tokens,
          }),
          ...(validCount(totals.output_tokens) && { outputTokens: totals.output_tokens }),
          fetchedAt,
        };
      } else {
        // Legacy pre-2026-10 shape: `limits.{session,weekly,monthly}.usage`
        // fractions (rollback guard — the endpoint switched shapes wholesale).
        const limits = parsed.limits ?? {};
        const window = (key: "session" | "weekly" | "monthly") =>
          validFraction(limits[key]?.usage) ? limits[key].usage : undefined;
        const session = window("session");
        const weekly = window("weekly");
        const monthly = window("monthly");
        if (session !== undefined || weekly !== undefined || monthly !== undefined) {
          // At least one recognised window — legacy plans carry session+weekly,
          // current credit plans carry monthly only. Reset moments: session and
          // weekly derive from the window anchoring; monthly needs the separate
          // /api/me billing-period lookup.
          const fetchedAt = Date.now();
          result = {
            kind: "success",
            ...(session !== undefined && { session, sessionResetAt: nextSessionReset(fetchedAt) }),
            ...(weekly !== undefined && { weekly, weeklyResetAt: nextWeeklyReset(fetchedAt) }),
            ...(monthly !== undefined && { monthly }),
            fetchedAt,
          };
          if (monthly !== undefined) {
            const { monthlyResetAt } = await lookupAccountInfo(apiKey);
            if (monthlyResetAt !== undefined) result.monthlyResetAt = monthlyResetAt;
          }
        } else {
          log("ollama-cloud: response shape not recognised (endpoint may have changed)");
          result = { kind: "unavailable" };
        }
      }
    }
  } catch (e) {
    log(`ollama-cloud: fetch failed (${e instanceof Error ? e.message : String(e)})`);
    result = { kind: "unavailable" };
  }

  setCached(result);
  return result;
}

// Re-exports for consumers (CLI + tests).
export { clearCache, clearCache as clearOcCache } from "./cache.js";
export { fetchOcMe, fetchOcUsage, ME_URL, USAGE_RANGE, USAGE_URL } from "./client.js";
export { formatOcSection } from "./format.js";
export { loadApiKey, ENV_API_KEY } from "./config.js";
export type { OcQueryResult, OcUsageResponse } from "./types.js";
