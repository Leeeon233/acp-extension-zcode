/**
 * ZCode credential and environment handling.
 *
 * Vendored from the reference Python implementation so this package stays
 * self-contained. The ZCode desktop app stores provider credentials in
 * `~/.zcode/v2/config.json`; GUI-launched processes don't inherit shell env
 * vars, so we read the config and inject the active provider's settings into
 * the subprocess environment.
 */

import { readFileSync } from "node:fs";
import process from "node:process";

import { DEFAULT_MODEL_ID, providerSelectable } from "../config/options.js";
import { log, ZCODE_CREDS_PATH } from "../utils.js";

/** Parsed provider entry in config.json. */
interface ProviderConfig {
  enabled?: boolean;
  options?: { baseURL?: string; apiKey?: string; apiKeyRequired?: boolean };
  models?: Record<string, unknown>;
}

interface ZcodeConfig {
  provider?: Record<string, ProviderConfig>;
}

/** Credentials extracted from the active provider. */
export interface ZcodeCredentials {
  ZCODE_MODEL?: string;
  ZCODE_BASE_URL?: string;
  ANTHROPIC_API_KEY?: string;
}

/** Read the active provider's credentials from config.json. Best-effort. */
export function loadZcodeCredentials(): ZcodeCredentials {
  try {
    const cfg = JSON.parse(readFileSync(ZCODE_CREDS_PATH, "utf8")) as ZcodeConfig;
    // ZCODE_PROVIDER pins the provider by id; unset keeps the historical
    // "first enabled provider wins" behaviour.
    const pinned = process.env.ZCODE_PROVIDER;
    for (const [providerId, p] of Object.entries(cfg.provider ?? {})) {
      // Mirror the model dropdown's providerSelectable rule (#183): a
      // keyless builtin provider (typical after plan upgrades in the App)
      // would inject an empty ANTHROPIC_API_KEY and every turn fails — skip
      // it in the default scan. Custom keyless providers stay selectable
      // when they are local or declare apiKeyRequired:false (ollama/
      // llama.cpp, #156). An explicit pin still honors the user's choice.
      if (!pinned && !providerSelectable(providerId, p as Parameters<typeof providerSelectable>[1]))
        continue;
      if (p?.enabled && (!pinned || providerId === pinned)) {
        const opts = p.options ?? {};
        const models = p.models ?? {};
        return {
          ZCODE_MODEL: Object.keys(models)[0] ?? DEFAULT_MODEL_ID,
          ZCODE_BASE_URL: opts.baseURL ?? "",
          ANTHROPIC_API_KEY: opts.apiKey ?? "",
        };
      }
    }
  } catch (e) {
    log(
      `credentials: failed to read ${ZCODE_CREDS_PATH}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return {};
}

/**
 * Merge process.env with config credentials.
 *
 * Explicit non-empty env vars override config (so `ZCODE_MODEL=foo` works as a
 * temporary override). Empty-string env vars are treated as unset so they
 * don't clobber the config value.
 *
 * Also self-heals a stale `ZCODE_BASE_URL`: if the env value is the endpoint
 * of a *different* provider in config (a leftover from switching plans in the
 * App), revert to the enabled provider's URL. User-defined custom endpoints
 * are respected.
 */
export function mergeEnvWithCreds(creds: ZcodeCredentials): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env, ...creds };
  for (const k of ["ZCODE_MODEL", "ZCODE_BASE_URL", "ANTHROPIC_API_KEY"] as const) {
    const v = process.env[k];
    if (v) merged[k] = v;
  }

  // Stale-baseURL self-heal. Skipped when ANTHROPIC_API_KEY is explicitly
  // exported: the env key+URL pair is then self-consistent by construction
  // (the user pointed it at the provider that key belongs to), and reverting
  // the URL would send that key to the wrong host (#183).
  const envBu = process.env.ZCODE_BASE_URL ?? "";
  const configBu = creds.ZCODE_BASE_URL ?? "";
  if (envBu && configBu && envBu !== configBu && !process.env.ANTHROPIC_API_KEY) {
    const allHosts = collectProviderHosts();
    const envHost = hostOf(envBu);
    const configHost = hostOf(configBu);
    if (envHost && configHost && envHost !== configHost && allHosts.has(envHost)) {
      merged.ZCODE_BASE_URL = configBu;
      log(
        `credentials: ZCODE_BASE_URL stale-host detected (env='${envBu}' is another ` +
          `provider's endpoint); reverted to config='${configBu}'.`,
      );
    }
  }
  return merged;
}

function collectProviderHosts(): Set<string> {
  const hosts = new Set<string>();
  try {
    const cfg = JSON.parse(readFileSync(ZCODE_CREDS_PATH, "utf8")) as ZcodeConfig;
    for (const p of Object.values(cfg.provider ?? {})) {
      const bu = p?.options?.baseURL ?? "";
      const h = hostOf(bu);
      if (h) hosts.add(h);
    }
  } catch {
    // ignore — stale detection just degrades gracefully
  }
  return hosts;
}

function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}
