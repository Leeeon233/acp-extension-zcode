/**
 * Opencode Go usage orchestration — the entry point used by the
 * `zcode-acp quota` CLI and the quota dock.
 *
 * Flow: credentials (env + config file) → cache check → fetch → status/auth
 * check → parse → cache write. Any thrown error degrades to `unavailable`
 * rather than propagating, so the CLI always produces output.
 *
 * Two fetch sources (cookie console API preferred for its 0.1-percent
 * precision; the API-key usage API as the cookie-free fallback — see
 * queryGoUsage). A missing/invalid credential on every source yields
 * `not_configured`, which the combined view silently skips (vs.
 * `unavailable`, which renders an error line) — so users who only care about
 * GLM see no noise.
 */

import { loadUserConfig } from "../../config/user-config.js";
import { log } from "../../utils.js";
import { getCached, setCached } from "./cache.js";
import {
  ENV_API_KEY,
  ENV_AUTH_COOKIE,
  ENV_SESSION_TOKEN,
  ENV_WORKSPACE_ID,
  readConfigFile,
} from "./config.js";
import { fetchGoStatus, fetchZenUsage } from "./client.js";
import { parseGoStatus, parseZenUsage, type ParsedGoStatus } from "./parse.js";
import type { GoQueryResult } from "./types.js";

/** Format validators (match pi-go-bars conventions). */
const RE_WORKSPACE = /^wrk_[A-Za-z0-9]+$/;
const COOKIE_PREFIX = "Fe26.2**";

/** Minimum plausible session-token length (console `st_…` values). */
const MIN_SESSION_TOKEN = 8;

/** Minimum plausible API-key length (`oc_sk_…` service keys). */
const MIN_API_KEY = 16;

/**
 * Resolved Opencode Go credentials — two independent sources for the same
 * usage data (see ./client.ts for why both exist).
 */
interface GoCredentials {
  /** Cookie triple for the console status API (0.1-percent precision). */
  console: { workspaceId: string; authCookie: string; sessionToken: string } | null;
  /** Service API key for the public usage API (cookie-free fallback). */
  apiKey: string | null;
}

/**
 * Resolve & validate credentials.
 *
 * The cookie triple merges three sources field-by-field with the standard
 * user-config precedence (highest first):
 *   1. `quota.opencodeGoWorkspaceId` / `opencodeGoAuthCookie` /
 *      `opencodeGoSessionToken` in `~/.config/zcode-acp/config.json` (our own
 *      config — preferred home).
 *   2. `OPENCODE_GO_WORKSPACE_ID` / `OPENCODE_GO_AUTH_COOKIE` /
 *      `OPENCODE_GO_SESSION_TOKEN` env vars.
 *   3. `~/.pi/agent/opencode-go.json` (legacy — the @beyona/pi-zai-usage Pi
 *      extension convention, kept so existing setups keep working).
 *
 * The API key (`quota.opencodeGoApiKey` / `OPENCODE_GO_API_KEY`) has no legacy
 * file source. The session token is REQUIRED since the 2026-09 console
 * migration: the status API answers 401 to an `auth` cookie alone. A field
 * present in a higher-precedence source overrides the same field below it; a
 * field present only lower down still counts.
 */
function loadCredentials(): GoCredentials {
  const own = loadUserConfig().quota;
  const file = readConfigFile();
  const workspaceId =
    own?.opencodeGoWorkspaceId ?? process.env[ENV_WORKSPACE_ID] ?? file.workspaceId;
  const authCookie = own?.opencodeGoAuthCookie ?? process.env[ENV_AUTH_COOKIE] ?? file.authCookie;
  const sessionToken =
    own?.opencodeGoSessionToken ?? process.env[ENV_SESSION_TOKEN] ?? file.sessionToken;

  let consoleCreds: GoCredentials["console"] = null;
  if (workspaceId && authCookie && sessionToken) {
    if (!RE_WORKSPACE.test(workspaceId)) {
      log(`opencode-go: invalid workspaceId format (expected wrk_…)`);
    } else if (!authCookie.startsWith(COOKIE_PREFIX)) {
      log(`opencode-go: authCookie does not start with ${COOKIE_PREFIX}`);
    } else if (sessionToken.trim().length < MIN_SESSION_TOKEN) {
      log(`opencode-go: sessionToken looks malformed (__Host-console_session value, st_…)`);
    } else {
      consoleCreds = { workspaceId, authCookie, sessionToken };
    }
  }

  const rawKey = own?.opencodeGoApiKey ?? process.env[ENV_API_KEY] ?? "";
  const apiKey = rawKey.trim().length >= MIN_API_KEY ? rawKey.trim() : null;

  return { console: consoleCreds, apiKey };
}

/** Map a parsed payload to the success/unavailable distinction. */
function resultFromParsed(parsed: ParsedGoStatus): GoQueryResult {
  if (parsed.parserOutdated) {
    log("opencode-go: status JSON recognised but no windows parsed (parser outdated)");
    return { kind: "unavailable" };
  }
  if (!parsed.rolling && !parsed.weekly && !parsed.monthly) {
    // Not a status payload at all (e.g. an HTML error page).
    return { kind: "unavailable" };
  }
  return {
    kind: "success",
    // Rolling and weekly are the two windows the CLI shows by default; fall
    // back to zeroes if somehow absent so the type stays simple.
    rolling: parsed.rolling ?? { usagePercent: 0, resetInSec: 0 },
    weekly: parsed.weekly ?? { usagePercent: 0, resetInSec: 0 },
    monthly: parsed.monthly,
    fetchedAt: Date.now(),
  };
}

/**
 * Query Opencode Go usage and return a normalised {@link GoQueryResult}.
 *
 * Source selection: the COOKIE triple is preferred (0.1-percent precision);
 * when it is absent — or the console API rejects it (400/401/403: expired
 * cookies) while an API key is configured — the public usage API serves the
 * fallback (integer percents). This keeps long-lived cookie setups on the
 * finer source while key-only setups, and cookie expiry, degrade seamlessly.
 *
 * - No usable credential → `not_configured`.
 * - Serves a cached result when fresh (< 10s).
 * - Auth rejected on BOTH paths → `auth_error`.
 * - Network/timeout/parse failure → `unavailable`.
 */
export async function queryGoUsage(): Promise<GoQueryResult> {
  const cached = getCached();
  if (cached) {
    log("opencode-go: serving cached result");
    return cached;
  }

  const creds = loadCredentials();
  if (!creds.console && !creds.apiKey) return { kind: "not_configured" };

  let result: GoQueryResult;
  if (creds.console) {
    try {
      const resp = await fetchGoStatus(
        creds.console.workspaceId,
        creds.console.authCookie,
        creds.console.sessionToken,
      );

      // 401/403 = bad cookie pair; 400 = missing/unknown org id (x-org-id).
      // The remedy is the same for all three — re-grab credentials — so they
      // share auth_error… unless an API key is available, in which case the
      // cookie-free endpoint takes over instead of failing the card.
      if ((resp.status === 400 || resp.status === 401 || resp.status === 403) && creds.apiKey) {
        log("opencode-go: console cookies rejected — falling back to the usage API key");
        result = await queryViaApiKey(creds.apiKey);
      } else if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        result = { kind: "auth_error" };
      } else if (resp.status < 200 || resp.status >= 300) {
        result = { kind: "unavailable" };
      } else {
        result = resultFromParsed(parseGoStatus(resp.text));
      }
    } catch (e) {
      log(`opencode-go: fetch failed (${e instanceof Error ? e.message : String(e)})`);
      result = { kind: "unavailable" };
    }
  } else {
    // Key-only setup — no cookie triple to try first.
    result = await queryViaApiKey(creds.apiKey!);
  }

  setCached(result);
  return result;
}

/** Query the public usage API (`/zen/go/v1/usage`) with the service key. */
async function queryViaApiKey(apiKey: string): Promise<GoQueryResult> {
  try {
    const resp = await fetchZenUsage(apiKey);
    if (resp.status === 401) {
      return { kind: "auth_error" };
    }
    if (resp.status < 200 || resp.status >= 300) {
      return { kind: "unavailable" };
    }
    return resultFromParsed(parseZenUsage(resp.text));
  } catch (e) {
    log(`opencode-go: usage API fetch failed (${e instanceof Error ? e.message : String(e)})`);
    return { kind: "unavailable" };
  }
}

// Re-exports for consumers (CLI + tests).
export { clearCache, clearCache as clearGoCache } from "./cache.js";
export { fetchGoStatus, fetchZenUsage, goStatusUrl, zenUsageUrl } from "./client.js";
export { parseGoStatus, parseZenUsage, looksLikeGoStatus, looksLikeZenUsage } from "./parse.js";
export { formatDuration, formatGoSection } from "./format.js";
export {
  readConfigFile,
  CONFIG_PATH,
  ENV_WORKSPACE_ID,
  ENV_AUTH_COOKIE,
  ENV_SESSION_TOKEN,
  ENV_API_KEY,
} from "./config.js";
export type { GoQueryResult, GoWindow, GoWindowKey, GoStatusResponse } from "./types.js";
