/**
 * Header-shape test for the real Opencode Go HTTP clients.
 *
 * Lives in its own file (no `vi.mock`) so `fetchGoStatus`/`fetchZenUsage` are
 * the real implementations and we can assert on the exact request passed to
 * global fetch — the console API contract needs BOTH cookies plus the
 * `x-org-id` header (verified live 2026-09-19: missing session cookie → 401,
 * missing org header → 400), the public usage API needs just the Bearer key
 * (verified live 2026-10-19). Other opencode-go tests mock the client module.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchGoStatus, fetchZenUsage } from "../src/quota/opencode-go/client.js";

// One file-level spy shared by both describes — a second vi.spyOn on the same
// method from a sibling describe pollutes call counts across suites.
const fetchSpy = vi.spyOn(globalThis, "fetch");

afterEach(() => {
  fetchSpy.mockReset();
});

describe("fetchGoStatus request shape", () => {
  it("sends both auth cookies and x-org-id to the console status API", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

    await fetchGoStatus("wrk_x", "Fe26.2**secret", "st_123456");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    const url = call[0];
    const init = (call[1] ?? {}) as RequestInit;
    const headers = init.headers as Record<string, string>;

    expect(String(url)).toBe("https://opencode.ai/console/api/go/status");
    expect(init.method).toBe("GET");
    expect(headers.Cookie).toBe("auth=Fe26.2**secret; __Host-console_session=st_123456");
    expect(headers["x-org-id"]).toBe("wrk_x");
    expect(headers.Accept).toBe("application/json");
  });

  it("does not throw on 401 — returns the status for the caller to classify", async () => {
    fetchSpy.mockResolvedValue(new Response("", { status: 401 }));
    const resp = await fetchGoStatus("wrk_x", "Fe26.2**secret", "st_123456");
    expect(resp.status).toBe(401);
  });
});

describe("fetchZenUsage request shape", () => {
  it("sends only the Bearer key to the public usage API — no cookies, no org header", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));

    await fetchZenUsage("oc_sk_test_key_12345");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const call = fetchSpy.mock.calls[0]!;
    const init = (call[1] ?? {}) as RequestInit;
    const headers = init.headers as Record<string, string>;

    expect(String(call[0])).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(init.method).toBe("GET");
    expect(headers.Authorization).toBe("Bearer oc_sk_test_key_12345");
    expect(headers.Cookie).toBeUndefined();
    expect(headers["x-org-id"]).toBeUndefined();
  });

  it("does not throw on 401 — returns the status for the caller to classify", async () => {
    fetchSpy.mockResolvedValue(new Response("", { status: 401 }));
    const resp = await fetchZenUsage("oc_sk_test_key_12345");
    expect(resp.status).toBe(401);
  });
});
