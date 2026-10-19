/**
 * Opencode Go status HTTP client.
 *
 * Two sources, in preference order (the orchestrator picks):
 *
 * 1. The console status API (`/console/api/go/status`) — cookie auth, reports
 *    usage in 0.1-percent steps. The Go dashboard moved off the legacy SSR
 *    page (`/workspace/<id>/go` — that URL now bounces EVERY cookie to the
 *    login page, observed 2026-09-19) onto the console at
 *    `https://opencode.ai/console/<org>/go`, backed by this JSON API. Usage
 *    arrives as micro-cents meter pairs per window; the parser turns them
 *    into percent + countdown.
 *
 * 2. The public usage API (`/zen/go/v1/usage`, opencode PR #16513) — a single
 *    service-account API key (`oc_sk_…`) as a Bearer token, no cookies, no
 *    org header. Reports integer percents + absolute reset timestamps; the
 *    cookie source keeps 0.1 precision, so it stays preferred and this is the
 *    fallback for setups without (or with expired) cookies.
 *
 * Console auth needs THREE pieces (verified against the live API 2026-09-19):
 * the `auth` cookie, the `__Host-console_session` cookie, and the `x-org-id`
 * header. Missing session cookie → 401, missing org header → 400; any
 * User-Agent works (one is sent for parity with the console's own requests).
 */

/** Request timeout (ms). */
const TIMEOUT_MS = 10_000;

/** Browser-like User-Agent, mirroring the console's own XHR requests. */
const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Gecko/20100101 Firefox/148.0";

/** The console status API endpoint (the org rides the `x-org-id` header). */
export function goStatusUrl(): string {
  return "https://opencode.ai/console/api/go/status";
}

/** The public usage API endpoint (key auth; the console /zen path proxies it). */
export function zenUsageUrl(): string {
  return "https://opencode.ai/zen/go/v1/usage";
}

/**
 * Fetch the Go status JSON.
 *
 * @throws on network errors or timeout; the caller maps these to
 *         `unavailable`. Auth failures are NOT thrown here — the HTTP status
 *         is returned so the orchestrator can classify 400/401/403 as
 *         `auth_error`.
 */
export async function fetchGoStatus(
  workspaceId: string,
  authCookie: string,
  sessionToken: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ status: number; text: string }> {
  const resp = await fetchImpl(goStatusUrl(), {
    method: "GET",
    headers: {
      Cookie: `auth=${authCookie}; __Host-console_session=${sessionToken}`,
      "x-org-id": workspaceId,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await resp.text();
  return { status: resp.status, text };
}

/**
 * Fetch the public usage JSON with an API key. Same no-throw contract as
 * {@link fetchGoStatus}: network errors throw (→ `unavailable`), auth
 * failures come back as HTTP 401.
 */
export async function fetchZenUsage(
  apiKey: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ status: number; text: string }> {
  const resp = await fetchImpl(zenUsageUrl(), {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await resp.text();
  return { status: resp.status, text };
}
