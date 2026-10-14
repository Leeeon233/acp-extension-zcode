/**
 * CLIProxyAPI management HTTP client.
 *
 * Two calls, both Bearer-authed with the management key:
 * - credentials listing (v8: `/v8/management/credentials`; the v0 servers
 *   that still exist answer `/v0/management/auth-files` — probed once, the
 *   working spelling cached for the process);
 * - `api-call` — the credential-scoped upstream relay the management web UI
 *   itself uses for Gemini quota.
 *
 * No retries beyond the URL-candidate ladder: a remote quota card must fail
 * fast into `unavailable`, not hang the combined view.
 */

import type { CpResponse } from "./types.js";

const TIMEOUT_MS = 10_000;

/** Both route spellings, tried in order; the winner is cached per process. */
const CREDENTIALS_ROUTES = ["/v8/management/credentials", "/v0/management/auth-files"];
const API_CALL_ROUTES = ["/v8/management/api-call", "/v0/management/api-call"];

/**
 * Upstream quota endpoints CPAMC itself tries, in order
 * (Cli-Proxy-API-Management-Center `constants.ts`): the primary internal
 * quota API first, sandbox and bare variants as fallbacks.
 */
export const QUOTA_SUMMARY_URLS = [
  "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:retrieveUserQuotaSummary",
  "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
] as const;

/** Route-spelling memory (set on first success; 404 keeps probing). */
let credentialsRoute: string | null = null;
let apiCallRoute: string | null = null;

/** Hook: forget the cached route spellings (tests, and watch-mode ticks so a
 *  server upgrade mid-watch re-probes instead of sticking to a stale route). */
export function resetRouteCache(): void {
  credentialsRoute = null;
  apiCallRoute = null;
}

function authHeaders(key: string): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    "X-Management-Key": key,
    Accept: "application/json",
  };
}

async function fetchOnce(
  url: string,
  key: string,
  init: RequestInit,
  fetchImpl: typeof globalThis.fetch,
): Promise<CpResponse> {
  const resp = await fetchImpl(url, {
    ...init,
    headers: { ...authHeaders(key), ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: resp.status, text: await resp.text() };
}

/** Probe the route spellings until one answers non-404 (cached afterwards). */
async function fetchRouted(
  base: string,
  key: string,
  routes: readonly string[],
  cached: string | null,
  init: RequestInit,
  fetchImpl: typeof globalThis.fetch,
): Promise<{ route: string | null; resp: CpResponse }> {
  if (cached) {
    return { route: cached, resp: await fetchOnce(`${base}${cached}`, key, init, fetchImpl) };
  }
  let last: CpResponse = { status: 404, text: "" };
  for (const route of routes) {
    last = await fetchOnce(`${base}${route}`, key, init, fetchImpl);
    if (last.status !== 404) return { route, resp: last };
  }
  return { route: null, resp: last };
}

/**
 * List the proxy's credential entries. 401/403 surfaces to the caller as
 * `auth_error`; other statuses as `unavailable`.
 */
export async function fetchCredentials(
  base: string,
  key: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<CpResponse> {
  const { route, resp } = await fetchRouted(
    base,
    key,
    CREDENTIALS_ROUTES,
    credentialsRoute,
    { method: "GET" },
    fetchImpl,
  );
  if (route) credentialsRoute = route;
  return resp;
}

/**
 * Relay `retrieveUserQuotaSummary` for one account. `$TOKEN$` is substituted
 * by the proxy with that credential's OAuth token — the key never sees the
 * token, and we never see it either (it stays server-side).
 *
 * @returns the relay response (its `body` is the upstream JSON as a STRING),
 *          or null when every URL candidate failed fast (network/timeout).
 */
export async function fetchQuotaSummary(
  base: string,
  key: string,
  authIndex: string,
  projectId: string | undefined,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<CpResponse | null> {
  for (const url of QUOTA_SUMMARY_URLS) {
    const { route, resp } = await fetchRouted(
      base,
      key,
      API_CALL_ROUTES,
      apiCallRoute,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          auth_index: authIndex,
          method: "POST",
          url,
          header: { Authorization: "Bearer $TOKEN$", "Content-Type": "application/json" },
          data: JSON.stringify(projectId !== undefined ? { project: projectId } : {}),
        }),
      },
      fetchImpl,
    );
    if (route) apiCallRoute = route;
    // The relay answers 200 with the upstream status inside; a non-200 here
    // is the relay/proxy itself failing — try the next upstream URL variant.
    if (resp.status === 200) return resp;
  }
  return null;
}
