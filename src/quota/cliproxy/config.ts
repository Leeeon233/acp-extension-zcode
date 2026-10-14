/**
 * CLIProxyAPI credential discovery — the same convention as the Ollama card:
 * config file first (`~/.config/zcode-acp/config.json` `quota.cliproxyUrl` +
 * `quota.cliproxyManagementKey`), env vars as a full fallback
 * (`CLIPROXY_URL` / `CLIPROXY_MANAGEMENT_KEY`).
 *
 * A missing URL or key yields `not_configured` (the section is silently
 * skipped in `all` mode). An `http://` URL to a non-loopback host is refused
 * at query time — see {@link loadCpConfig}.
 */

import process from "node:process";

import { loadUserConfig } from "../../config/user-config.js";

export const ENV_URL = "CLIPROXY_URL";
export const ENV_KEY = "CLIPROXY_MANAGEMENT_KEY";

export interface CpConfig {
  /** Base URL, no trailing slash/path (e.g. `https://cp.example.com:8317`). */
  url: string;
  /** Management key (`remote-management.secret-key`). */
  key: string;
}

/**
 * Resolve the endpoint + key. Blank strings count as absent. The URL gets a
 * trailing-slash trim so `https://host/` still works.
 */
export function loadCpConfig(): CpConfig | null {
  const quota = loadUserConfig().quota;
  const url = (quota?.cliproxyUrl ?? process.env[ENV_URL] ?? "").trim().replace(/\/+$/, "");
  const key = (quota?.cliproxyManagementKey ?? process.env[ENV_KEY] ?? "").trim();
  if (!url || !key) return null;
  return { url, key };
}
