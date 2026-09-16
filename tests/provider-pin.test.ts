/**
 * ZCODE_PROVIDER pins which provider in config.json the bridge uses.
 *
 * Without it the historical rule holds: credentials come from the FIRST
 * enabled provider and the model dropdown lists every selectable one. With
 * it, both are restricted to the pinned provider id.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { ZCODE_CREDS_PATH } from "../src/utils.js";

function plan(name: string, baseURL: string, apiKey: string, modelId: string) {
  return {
    name,
    kind: "anthropic",
    enabled: true,
    options: { apiKey, apiKeyRequired: true, baseURL },
    models: { [modelId]: { limit: { context: 200000 } } },
  };
}

function twoEnabledProviders() {
  return {
    provider: {
      "builtin:first": plan("First", "https://first.example/api", "first-key", "GLM-first"),
      "builtin:second": plan("Second", "https://second.example/api", "second-key", "GLM-second"),
    },
  };
}

let fakeConfig: unknown = twoEnabledProviders();

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: (p: string) => {
      if (p === ZCODE_CREDS_PATH) return JSON.stringify(fakeConfig);
      return actual.readFileSync(p);
    },
  };
});

const { loadZcodeCredentials } = await import("../src/backend/credentials.js");
const { loadAllModels } = await import("../src/config/options.js");

afterEach(() => {
  fakeConfig = twoEnabledProviders();
  vi.unstubAllEnvs();
});

describe("loadZcodeCredentials provider pinning", () => {
  it("falls back to the first enabled provider when ZCODE_PROVIDER is unset", () => {
    expect(loadZcodeCredentials()).toEqual({
      ZCODE_MODEL: "GLM-first",
      ZCODE_BASE_URL: "https://first.example/api",
      ANTHROPIC_API_KEY: "first-key",
    });
  });

  it("picks the pinned provider even when it is not first", () => {
    vi.stubEnv("ZCODE_PROVIDER", "builtin:second");

    expect(loadZcodeCredentials()).toEqual({
      ZCODE_MODEL: "GLM-second",
      ZCODE_BASE_URL: "https://second.example/api",
      ANTHROPIC_API_KEY: "second-key",
    });
  });

  it("returns nothing when the pinned provider is absent or disabled", () => {
    vi.stubEnv("ZCODE_PROVIDER", "builtin:missing");

    expect(loadZcodeCredentials()).toEqual({});
  });
});

describe("loadAllModels provider pinning", () => {
  it("lists every enabled provider when ZCODE_PROVIDER is unset", () => {
    expect(loadAllModels().map((m) => m.providerId)).toEqual(["builtin:first", "builtin:second"]);
  });

  it("lists only the pinned provider's models", () => {
    vi.stubEnv("ZCODE_PROVIDER", "builtin:second");

    expect(loadAllModels()).toEqual([
      { providerId: "builtin:second", providerName: "Second", modelId: "GLM-second" },
    ]);
  });
});
