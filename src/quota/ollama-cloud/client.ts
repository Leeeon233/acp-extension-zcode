/**
 * Ollama Cloud usage HTTP client.
 *
 * Talks to `https://ollama.com/api/usage` — an undocumented but live endpoint
 * that returns `{limits:{session:{usage},weekly:{usage}}}` with usage as a
 * 0..1 fraction. Auth is a plain Bearer API key (docs.ollama.com). No
 * rate-limit headers exist on any Ollama endpoint, so the body is the only
 * data source.
 */

/** Request timeout (ms). Small JSON response; 10s is plenty. */
const TIMEOUT_MS = 10_000;

/** The undocumented usage endpoint (verified live 2026-09). */
export const USAGE_URL = "https://ollama.com/api/usage";

/**
 * Fetch the usage JSON body.
 *
 * @throws on network errors or timeout. The caller maps these to
 *         `unavailable`. Auth failures are NOT thrown — the status is
 *         returned so the orchestrator can classify 401/403 as `auth_error`.
 */
export async function fetchOcUsage(
  apiKey: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ status: number; text: string }> {
  const resp = await fetchImpl(USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await resp.text();
  return { status: resp.status, text };
}
