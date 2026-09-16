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
import { fetchOcUsage } from "./client.js";
import type { OcQueryResult } from "./types.js";

/**
 * Validate a usage value from the response body: a finite number in [0, 1].
 *
 * Values > 1 are rejected on purpose: the endpoint is undocumented, and if
 * Ollama ever switches to percent-valued numbers, silently treating 42 as a
 * 4200% fraction would render a nonsensical full bar. The same guard is used
 * by the pi-multi-account reference client.
 */
function validFraction(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * Query Ollama Cloud usage and return a normalised {@link OcQueryResult}.
 *
 * - No key → `not_configured`.
 * - Serves a cached result when fresh (< 10s).
 * - HTTP 401/403 → `auth_error` (bad or revoked key).
 * - Network/timeout/parse failure → `unavailable`.
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
        limits?: Record<string, { usage?: unknown } | undefined>;
      };
      const limits = parsed.limits ?? {};
      const window = (key: "session" | "weekly" | "monthly") =>
        validFraction(limits[key]?.usage) ? limits[key].usage : undefined;
      const session = window("session");
      const weekly = window("weekly");
      const monthly = window("monthly");
      if (session !== undefined || weekly !== undefined || monthly !== undefined) {
        // At least one recognised window — legacy plans carry session+weekly,
        // current credit plans carry monthly only.
        result = {
          kind: "success",
          ...(session !== undefined && { session }),
          ...(weekly !== undefined && { weekly }),
          ...(monthly !== undefined && { monthly }),
          fetchedAt: Date.now(),
        };
      } else {
        log("ollama-cloud: response shape not recognised (endpoint may have changed)");
        result = { kind: "unavailable" };
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
export { fetchOcUsage, USAGE_URL } from "./client.js";
export { formatOcSection } from "./format.js";
export { loadApiKey, ENV_API_KEY } from "./config.js";
export type { OcQueryResult, OcUsageResponse } from "./types.js";
