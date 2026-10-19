/**
 * Opencode Go credential discovery — the LEGACY `~/.pi/agent/opencode-go.json`
 * fallback source.
 *
 * Full precedence (highest first), resolved in ../index.ts:
 *   1. `quota.opencodeGoWorkspaceId` / `opencodeGoAuthCookie` /
 *      `opencodeGoSessionToken` / `opencodeGoApiKey` in
 *      `~/.config/zcode-acp/config.json` (our own config).
 *   2. `OPENCODE_GO_WORKSPACE_ID` / `OPENCODE_GO_AUTH_COOKIE` /
 *      `OPENCODE_GO_SESSION_TOKEN` / `OPENCODE_GO_API_KEY` env vars (best for
 *      CI / scripts / temporary overrides).
 *   3. `~/.pi/agent/opencode-go.json` —
 *      `{ workspaceId, authCookie, sessionToken }` (the convention used by
 *      the @beyona/pi-zai-usage Pi extension, kept so users who already
 *      configured it there get reuse for free). No API-key field here — the
 *      key postdates that convention.
 *
 * The cookie triple and the API key are two SOURCES for the same data: the
 * triple drives the console status API (0.1-percent precision), the key the
 * public usage API (integer percents, cookie-free). A missing/invalid
 * credential on its own does not yield `not_configured` when the other
 * source resolves — see ../index.ts.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { log } from "../../utils.js";

/** Env var names — documented in the CLI help and README. */
export const ENV_WORKSPACE_ID = "OPENCODE_GO_WORKSPACE_ID";
export const ENV_AUTH_COOKIE = "OPENCODE_GO_AUTH_COOKIE";
export const ENV_SESSION_TOKEN = "OPENCODE_GO_SESSION_TOKEN";
export const ENV_API_KEY = "OPENCODE_GO_API_KEY";

/** Config file path (matches the @beyona/pi-zai-usage convention). */
export const CONFIG_PATH = path.join(
  process.env.HOME || process.env.USERPROFILE || "~",
  ".pi",
  "agent",
  "opencode-go.json",
);

/** Shape of the JSON config file. */
interface OpencodeGoConfig {
  workspaceId?: string;
  authCookie?: string;
  sessionToken?: string;
}

/**
 * Read (best-effort) the JSON config file. Returns an empty object on any
 * error — missing file, parse error, or wrong shape all degrade to "no fields
 * contributed", which the caller treats as `not_configured`.
 *
 * Best-effort mirrors {@link ../../backend/credentials.ts}: a missing or
 * corrupt config must never crash the bridge, only log.
 */
export function readConfigFile(filePath: string = CONFIG_PATH): OpencodeGoConfig {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      log(`opencode-go: config file is not a JSON object (${filePath})`);
      return {};
    }
    const cfg = parsed as Record<string, unknown>;
    return {
      workspaceId: typeof cfg.workspaceId === "string" ? cfg.workspaceId : undefined,
      authCookie: typeof cfg.authCookie === "string" ? cfg.authCookie : undefined,
      sessionToken: typeof cfg.sessionToken === "string" ? cfg.sessionToken : undefined,
    };
  } catch (e) {
    // ENOENT (most common — user hasn't created the file) is silent; other
    // read/parse errors are logged but still non-fatal.
    const msg = e instanceof Error ? e.message : String(e);
    if (!/ENOENT/.test(msg)) {
      log(`opencode-go: config read failed (${filePath}): ${msg}`);
    }
    return {};
  }
}
