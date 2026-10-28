/**
 * Model connectivity test: one minimal round-trip against a provider.
 *
 * The settings UI needs to answer "does this model actually work" without
 * sending a real prompt, which would cost tokens, pollute the session history
 * and (for a broken config) fail far from the field the user just edited. So
 * this module sends the smallest legal request for the provider's API format and
 * reports what came back.
 *
 * What it deliberately is NOT: a full model call. No streaming, no tools, no
 * system prompt, one token of output. A provider that answers `200` here can
 * still reject a real turn (quota, tool support, context), and the messages say
 * so rather than implying a green check means "this model is good".
 *
 * Auth resolution mirrors the runtime (`runtime-model.ts`): third-party
 * providers carry an inline key from `provider_config.json`, builtins use their
 * own OAuth/config credentials. A provider with no discoverable key is reported
 * as `no_key` instead of being sent an anonymous request — a 401 tells the user
 * nothing they did not already know, and some providers count it against the
 * account.
 */

import { readProviderConfig } from "../settings/provider-config.js";

/** The timeout for one probe (ms). Slow providers exist; a hang is worse. */
const TIMEOUT_MS = 20_000;

/** How much of a failure body is echoed back to the UI. */
const MAX_ERROR_CHARS = 400;

export interface ConnectivityResult {
  /** `success` means the provider answered a legal request without error. */
  success: boolean;
  /** HTTP status when a response was received at all. */
  status?: number;
  /** The provider's message, truncated — shown verbatim to the user. */
  message?: string;
  /** Why the probe could not run (as opposed to: ran and failed). */
  reason?: "no_key" | "no_base_url" | "unknown_provider";
  /** Round-trip time, for the "it answered in 812ms" note. */
  elapsedMs?: number;
}

/** A resolved endpoint + credential for one probe. */
interface ResolvedTarget {
  baseUrl: string;
  apiKey?: string;
  apiType: string;
}

/**
 * Resolve what to probe from the personal provider config.
 *
 * Returns a `reason` instead of throwing when the provider cannot be probed —
 * "not configured yet" is a normal state for a half-filled form, and an error
 * toast for it reads like a bug.
 */
export async function resolveTarget(
  providerId: string,
  modelId: string,
): Promise<{ target?: ResolvedTarget; result?: ConnectivityResult }> {
  const doc = await readProviderConfig();
  const rule = doc.config.providerConfigRules.providerRules.find(
    (r) => r.providerId === providerId,
  );
  if (!rule) return { result: { success: false, reason: "unknown_provider" } };
  const baseUrl = rule.config?.api?.baseUrl;
  if (!baseUrl) return { result: { success: false, reason: "no_base_url" } };
  const apiKey = rule.config?.access?.apiKey;
  if (!apiKey) return { result: { success: false, reason: "no_key" } };
  // The rule's declared format wins; the kind in `config.json` is the backstop
  // for a provider that predates the field.
  const apiType = rule.config?.api?.type ?? "openai-chat-completions";
  void modelId;
  return { target: { baseUrl, apiKey, apiType } };
}

/** Join a base URL and a path without doubling or dropping the separator. */
export function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

/** The request one probe sends, per API format. */
export interface ProbeRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * Build the probe request for an API format.
 *
 * Both formats get the same intent — "reply with one token" — spelled the way
 * each protocol expects. `max_tokens: 1` with a trivial prompt keeps the cost
 * at essentially zero; a model that rejects `max_tokens: 1` is itself a useful
 * finding, so no special-casing is attempted.
 */
export function buildProbeRequest(target: ResolvedTarget, modelId: string): ProbeRequest {
  const prompt = "ping";
  if (target.apiType === "anthropic-messages") {
    return {
      url: joinUrl(target.baseUrl, "messages"),
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": target.apiKey ?? "",
      },
      body: {
        model: modelId,
        max_tokens: 1,
        messages: [{ role: "user", content: prompt }],
      },
    };
  }
  if (target.apiType === "openai-responses") {
    return {
      url: joinUrl(target.baseUrl, "responses"),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${target.apiKey ?? ""}`,
      },
      body: { model: modelId, input: prompt, max_output_tokens: 16 },
    };
  }
  return {
    url: joinUrl(target.baseUrl, "chat/completions"),
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${target.apiKey ?? ""}`,
    },
    body: {
      model: modelId,
      max_tokens: 1,
      messages: [{ role: "user", content: prompt }],
    },
  };
}

/** Trim a provider's error body to something a toast can show. */
export function summariseError(status: number, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return `HTTP ${status}`;
  // JSON error envelopes are the common case and unreadable raw.
  try {
    const parsed = JSON.parse(trimmed) as {
      error?: { message?: unknown } | string;
      message?: unknown;
    };
    const detail =
      typeof parsed.error === "string"
        ? parsed.error
        : typeof parsed.error?.message === "string"
          ? parsed.error.message
          : typeof parsed.message === "string"
            ? parsed.message
            : undefined;
    if (detail) return `HTTP ${status}: ${detail.slice(0, MAX_ERROR_CHARS)}`;
  } catch {
    // Not JSON — fall through to the raw text.
  }
  return `HTTP ${status}: ${trimmed.slice(0, MAX_ERROR_CHARS)}`;
}

/**
 * Probe one model.
 *
 * Never throws for a provider-side failure: every outcome is a
 * {@link ConnectivityResult}, because the caller paints it inline rather than
 * failing a form submit.
 */
export async function testModelConnectivity(
  providerId: string,
  modelId: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ConnectivityResult> {
  const { target, result } = await resolveTarget(providerId, modelId);
  if (!target) return result ?? { success: false, reason: "unknown_provider" };
  const request = buildProbeRequest(target, modelId);
  const started = Date.now();
  try {
    const response = await fetchImpl(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const elapsedMs = Date.now() - started;
    if (response.ok) return { success: true, status: response.status, elapsedMs };
    const text = await response.text().catch(() => "");
    return {
      success: false,
      status: response.status,
      message: summariseError(response.status, text),
      elapsedMs,
    };
  } catch (error) {
    const elapsedMs = Date.now() - started;
    const message = error instanceof Error ? error.message : String(error);
    // A timeout is the most common "network" failure and deserves its own
    // wording — "The operation was aborted" is not a useful message.
    const timedOut = /timed? ?out|abort/iu.test(message);
    return {
      success: false,
      message: timedOut ? `no answer within ${TIMEOUT_MS / 1000}s` : message,
      elapsedMs,
    };
  }
}
