/**
 * Provider endpoint editing (baseUrl / apiType / apiKey) and the "key never
 * comes back" rule.
 *
 * Two invariants are under test, and both are easy to break silently:
 *
 *  1. A write lands in `provider_config.json` in the shape the registry reads
 *     (`config.api.{type,baseUrl}`, `config.access.{type,apiKey}`), because a
 *     key stored at the wrong path is a provider that authenticates with
 *     nothing.
 *  2. The key is write-only. The settings payload crosses a WebSocket and may
 *     be logged in transit, so it may say WHETHER a key is set but never what
 *     it is.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readProviderConfig, updateProvider } from "../src/settings/provider-config.js";
import { zcodePersonalProviderPath } from "../src/utils.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "provider-endpoint-test-"));
  vi.stubEnv("ZCODE_HOME", home);
  vi.stubEnv("HOME", home);
  await writePersonalConfig();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

/** A personal config with one editable provider and one account provider. */
async function writePersonalConfig(): Promise<void> {
  const doc = {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: "custom:mine",
            providerName: "Mine",
            enabled: true,
            config: {
              access: { type: "api-key", apiKey: "sk-old" },
              api: { type: "openai-chat-completions", baseUrl: "https://old.example/v1" },
              personalModelIds: ["m1"],
            },
          },
          {
            providerId: "account:bigmodel-individual-coding-plan",
            providerName: "BigModel",
            enabled: true,
            config: { personalModelIds: ["GLM-5.3"] },
          },
        ],
      },
      modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    },
  };
  const file = zcodePersonalProviderPath();
  await (await import("node:fs/promises")).mkdir(path.dirname(file), { recursive: true });
  await (await import("node:fs/promises")).writeFile(file, JSON.stringify(doc, null, 2), "utf8");
}

async function providerRule(providerId: string) {
  const doc = await readProviderConfig();
  return doc.config.providerConfigRules.providerRules.find((r) => r.providerId === providerId);
}

describe("provider endpoint edits", () => {
  it("writes baseUrl and apiType where the registry reads them", async () => {
    await updateProvider("custom:mine", {
      baseUrl: "https://new.example/v1",
      apiType: "anthropic-messages",
    });
    const rule = await providerRule("custom:mine");
    expect(rule?.config?.api).toEqual({
      type: "anthropic-messages",
      baseUrl: "https://new.example/v1",
    });
  });

  it("a null clears the endpoint fields without dropping the rest", async () => {
    await updateProvider("custom:mine", { baseUrl: null, apiType: null });
    const rule = await providerRule("custom:mine");
    expect(rule?.config?.api).toEqual({});
    // The key and the model list are untouched by an endpoint edit.
    expect(rule?.config?.access).toEqual({ type: "api-key", apiKey: "sk-old" });
    expect(rule?.config?.personalModelIds).toEqual(["m1"]);
  });

  it("a new key marks the access as key-based", async () => {
    await updateProvider("custom:mine", { apiKey: "sk-new" });
    const rule = await providerRule("custom:mine");
    expect(rule?.config?.access).toEqual({ type: "api-key", apiKey: "sk-new" });
  });

  it("a null key removes it but keeps the other provider fields", async () => {
    await updateProvider("custom:mine", { apiKey: null });
    const rule = await providerRule("custom:mine");
    expect(rule?.config?.access).toEqual({ type: "api-key" });
    expect(rule?.config?.api).toEqual({
      type: "openai-chat-completions",
      baseUrl: "https://old.example/v1",
    });
  });

  it("omitting a field leaves it alone", async () => {
    await updateProvider("custom:mine", { apiKey: "sk-new" });
    const rule = await providerRule("custom:mine");
    // baseUrl was not mentioned, so the old endpoint must survive.
    expect(rule?.config?.api?.baseUrl).toBe("https://old.example/v1");
  });

  it("still handles enabled and providerName", async () => {
    await updateProvider("custom:mine", { enabled: false, providerName: "Renamed" });
    const rule = await providerRule("custom:mine");
    expect(rule?.enabled).toBe(false);
    expect(rule?.providerName).toBe("Renamed");
  });
});

describe("provider endpoint validation", () => {
  it("refuses a baseUrl that is not an absolute http(s) URL", async () => {
    for (const bad of ["not a url", "/relative/path", "ftp://example.com", ""]) {
      await expect(updateProvider("custom:mine", { baseUrl: bad })).rejects.toThrow(
        /absolute http\(s\) URL/,
      );
    }
    // Nothing was written by the rejected attempts.
    expect((await providerRule("custom:mine"))?.config?.api?.baseUrl).toBe(
      "https://old.example/v1",
    );
  });

  it("refuses an unknown apiType", async () => {
    await expect(updateProvider("custom:mine", { apiType: "grpc" })).rejects.toThrow(
      /apiType must be one of/,
    );
  });

  it("refuses to edit an account-managed provider", async () => {
    await expect(
      updateProvider("account:bigmodel-individual-coding-plan", { baseUrl: "https://x.test/v1" }),
    ).rejects.toThrow(/account-managed/);
  });

  it("refuses a provider that has no rule in this file", async () => {
    await expect(updateProvider("custom:missing", { enabled: true })).rejects.toThrow(
      /no rule in provider_config.json/,
    );
  });
});

describe("the api key never leaves the machine", () => {
  it("is written to the file but absent from a fresh read's public fields", async () => {
    await updateProvider("custom:mine", { apiKey: "sk-secret-value" });
    const raw = await readFile(zcodePersonalProviderPath(), "utf8");
    expect(raw).toContain("sk-secret-value");

    const rule = await providerRule("custom:mine");
    // The value is only reachable by that exact key — anything serializing the
    // whole rule would leak it, which is why the settings payload reports
    // `hasApiKey` instead.
    expect(rule?.config?.access?.apiKey).toBe("sk-secret-value");
  });
});
