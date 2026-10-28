/**
 * The model connectivity probe.
 *
 * The valuable assertions here are about the REQUEST SHAPE (each API format
 * authenticates differently, and getting it wrong yields a 401 that looks like
 * a bad key) and about never throwing: the probe's whole job is to turn every
 * outcome into something the settings UI can paint inline.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildProbeRequest,
  joinUrl,
  summariseError,
  testModelConnectivity,
} from "../src/settings/model-connectivity.js";
import { zcodePersonalProviderPath } from "../src/utils.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "connectivity-test-"));
  vi.stubEnv("ZCODE_HOME", home);
  vi.stubEnv("HOME", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

/** Write a personal config with one provider in the given shape. */
async function seedProvider(rule: Record<string, unknown>): Promise<void> {
  const doc = {
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [rule] },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
  const file = zcodePersonalProviderPath();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(doc, null, 2), "utf8");
}

describe("request shape per API format", () => {
  it("anthropic-messages authenticates with x-api-key and a version header", () => {
    const req = buildProbeRequest(
      { baseUrl: "https://api.example/v1", apiKey: "sk-a", apiType: "anthropic-messages" },
      "claude-x",
    );
    expect(req.url).toBe("https://api.example/v1/messages");
    expect(req.headers["x-api-key"]).toBe("sk-a");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    // A bearer token is NOT how this protocol authenticates.
    expect(req.headers.authorization).toBeUndefined();
    expect(req.body).toMatchObject({ model: "claude-x", max_tokens: 1 });
  });

  it("openai-chat-completions authenticates with a bearer token", () => {
    const req = buildProbeRequest(
      {
        baseUrl: "https://api.example/v1",
        apiKey: "sk-b",
        apiType: "openai-chat-completions",
      },
      "gpt-x",
    );
    expect(req.url).toBe("https://api.example/v1/chat/completions");
    expect(req.headers.authorization).toBe("Bearer sk-b");
    expect(req.headers["x-api-key"]).toBeUndefined();
    expect(req.body).toMatchObject({
      model: "gpt-x",
      messages: [{ role: "user", content: "ping" }],
    });
  });

  it("openai-responses uses the responses path and `input`", () => {
    const req = buildProbeRequest(
      { baseUrl: "https://api.example/v1", apiKey: "sk-c", apiType: "openai-responses" },
      "o-x",
    );
    expect(req.url).toBe("https://api.example/v1/responses");
    expect(req.body).toMatchObject({ model: "o-x", input: "ping" });
  });

  it("joins URLs without doubling or dropping the separator", () => {
    expect(joinUrl("https://a.example/v1/", "chat/completions")).toBe(
      "https://a.example/v1/chat/completions",
    );
    expect(joinUrl("https://a.example/v1", "/chat/completions")).toBe(
      "https://a.example/v1/chat/completions",
    );
    expect(joinUrl("https://a.example/", "/messages")).toBe("https://a.example/messages");
  });
});

describe("error summarising", () => {
  it("pulls the message out of an OpenAI-shaped error", () => {
    const text = JSON.stringify({
      error: { message: "model not found", type: "invalid_request_error" },
    });
    expect(summariseError(404, text)).toBe("HTTP 404: model not found");
  });

  it("pulls the message out of an Anthropic-shaped error", () => {
    expect(summariseError(401, JSON.stringify({ error: "invalid x-api-key" }))).toBe(
      "HTTP 401: invalid x-api-key",
    );
  });

  it("falls back to the raw body, truncated", () => {
    const long = "x".repeat(1000);
    const out = summariseError(500, long);
    expect(out.startsWith("HTTP 500: ")).toBe(true);
    expect(out.length).toBeLessThan(500);
  });

  it("handles an empty body", () => {
    expect(summariseError(502, "")).toBe("HTTP 502");
  });
});

describe("probing", () => {
  it("reports success and the round trip", async () => {
    await seedProvider({
      providerId: "custom:p",
      providerName: "P",
      enabled: true,
      config: {
        access: { type: "api-key", apiKey: "sk" },
        api: { type: "openai-chat-completions", baseUrl: "https://api.example/v1" },
      },
    });
    const fake = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await testModelConnectivity("custom:p", "m1", fake as never);
    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(typeof result.elapsedMs).toBe("number");
    expect(fake).toHaveBeenCalledOnce();
  });

  it("reports a provider-side failure without throwing", async () => {
    await seedProvider({
      providerId: "custom:p",
      providerName: "P",
      enabled: true,
      config: {
        access: { type: "api-key", apiKey: "sk" },
        api: { type: "openai-chat-completions", baseUrl: "https://api.example/v1" },
      },
    });
    const fake = vi.fn(
      async () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    );
    const result = await testModelConnectivity("custom:p", "m1", fake as never);
    expect(result.success).toBe(false);
    expect(result.status).toBe(401);
    expect(result.message).toBe("HTTP 401: bad key");
  });

  it("does not send a request when no key is configured", async () => {
    await seedProvider({
      providerId: "custom:p",
      providerName: "P",
      enabled: true,
      config: {
        api: { type: "openai-chat-completions", baseUrl: "https://api.example/v1" },
      },
    });
    const fake = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await testModelConnectivity("custom:p", "m1", fake as never);
    expect(result.success).toBe(false);
    expect(result.reason).toBe("no_key");
    expect(fake).not.toHaveBeenCalled();
  });

  it("does not send a request when no base URL is configured", async () => {
    await seedProvider({
      providerId: "custom:p",
      providerName: "P",
      enabled: true,
      config: { access: { type: "api-key", apiKey: "sk" } },
    });
    const fake = vi.fn(async () => new Response("{}", { status: 200 }));
    const result = await testModelConnectivity("custom:p", "m1", fake as never);
    expect(result.reason).toBe("no_base_url");
    expect(fake).not.toHaveBeenCalled();
  });

  it("reports an unknown provider rather than failing the request", async () => {
    await seedProvider({ providerId: "custom:other", providerName: "O", enabled: true });
    const result = await testModelConnectivity("custom:missing", "m1", vi.fn() as never);
    expect(result.reason).toBe("unknown_provider");
  });

  it("turns a transport failure into a message", async () => {
    await seedProvider({
      providerId: "custom:p",
      providerName: "P",
      enabled: true,
      config: {
        access: { type: "api-key", apiKey: "sk" },
        api: { type: "openai-chat-completions", baseUrl: "https://api.example/v1" },
      },
    });
    const fake = vi.fn(async () => {
      throw new Error("getaddrinfo ENOTFOUND api.example");
    });
    const result = await testModelConnectivity("custom:p", "m1", fake as never);
    expect(result.success).toBe(false);
    expect(result.message).toContain("ENOTFOUND");
  });

  it("names a timeout as a timeout, not an abort", async () => {
    await seedProvider({
      providerId: "custom:p",
      providerName: "P",
      enabled: true,
      config: {
        access: { type: "api-key", apiKey: "sk" },
        api: { type: "openai-chat-completions", baseUrl: "https://api.example/v1" },
      },
    });
    const fake = vi.fn(async () => {
      throw new Error("The operation was aborted due to timeout");
    });
    const result = await testModelConnectivity("custom:p", "m1", fake as never);
    expect(result.success).toBe(false);
    expect(result.message).toContain("no answer within");
  });
});
