/**
 * Type definitions for the CLIProxyAPI quota feature.
 *
 * `zcode-acp quota cp` talks to a (typically REMOTE, user-deployed)
 * CLIProxyAPI instance's management API — the same channel its management web
 * UI uses (source-verified against CLIProxyAPI v8.0.28 + the CPAMC web UI,
 * 2026-10-14; see `.zcode/scratch/research-cliproxyapi-quota.md`):
 *
 *   1. `GET /v8/management/credentials` (v8 spelling; v0 servers answer
 *      `GET /v0/management/auth-files`) — one entry per upstream OAuth
 *      account. Gemini accounts are provider `antigravity`.
 *   2. For each Gemini account, `POST …/api-call` — a credential-scoped
 *      upstream call relay: the proxy substitutes `$TOKEN$` in the header
 *      with that account's OAuth token and forwards to
 *      `daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary`
 *      (CPAMC tries three URL variants in order). The response wraps the
 *      upstream body: `{status_code, header, body}` with `body` a STRING.
 *
 * The management key is a shared secret that can drive credential-bearing
 * upstream calls — HTTPS is mandatory, never plain HTTP over a network.
 *
 * REFRESH CADENCE: the Gemini quota summary rides a Google INTERNAL endpoint
 * with the account's own OAuth token, so every refresh is charged to that
 * Google account. The orchestrator therefore caches for 5 MINUTES regardless
 * of caller cadence (watch mode's 30s ticks included — they do not clear
 * this cache), and the renderer stamps the section's age when serving
 * cached values.
 *
 * Everything here is undocumented/best-effort: parse failures degrade to
 * `unavailable`, never a crash.
 */

/** One model's quota row: the tightest bucket of that model's set. */
export interface CpModelQuota {
  /** Model display name (e.g. "gemini-3-pro"). */
  name: string;
  /** Used fraction [0, 1] — 1 minus the model's LOWEST remainingFraction. */
  used: number;
  /** Reset moment of that tightest bucket (epoch ms), when reported. */
  resetAt?: number;
}

/** One upstream account's quota block. */
export interface CpAccountQuota {
  /** Short account label (email local-part, or the auth index). */
  label: string;
  /** Provider id from the credential entry — `antigravity` for Gemini. */
  provider: string;
  /** Per-model rows, tightest-first. Empty when the summary carried none. */
  models: CpModelQuota[];
}

/**
 * Result of querying CLIProxyAPI — a 4-state sum type mirroring
 * {@link ../ollama-cloud/types.js OcQueryResult}.
 *
 * `not_configured` = no URL/key resolved; the CLI silently skips the section
 * in all-provider mode. `success` with zero accounts = reachable server, no
 * Gemini accounts routed through it.
 */
export type CpQueryResult =
  | { kind: "success"; accounts: CpAccountQuota[]; fetchedAt: number }
  | { kind: "not_configured" }
  | { kind: "auth_error" }
  | { kind: "unavailable" };

/** Raw fetch result — status + body text (shared by both endpoints). */
export interface CpResponse {
  status: number;
  text: string;
}
