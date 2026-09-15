/**
 * Lody extension contract tests: capability advertisement, task metadata,
 * token accounting, and quota snapshot serialization.
 *
 * The Lody client consumes these shapes directly, so the tests pin the exact
 * field names from `acp-extension-core` (not provider-native names).
 */

import { describe, expect, it } from "vitest";

import {
  buildLodyTaskMeta,
  LODY_AGENT_CAPABILITIES,
  toLodyModelUsage,
  toLodyRateLimitsSnapshot,
  toLodyTaskStatus,
  withLodyMeta,
  withLodyToolName,
} from "../src/lody.js";
import type { GoQueryResult } from "../src/quota/opencode-go/types.js";
import type { QuotaResult } from "../src/quota/types.js";

describe("Lody capability advertisement", () => {
  it("covers only the implemented provider-neutral capabilities", () => {
    expect(LODY_AGENT_CAPABILITIES).toEqual({
      usage: { version: 1 },
      rateLimits: { version: 1, query: true },
      tasks: { version: 1, background: true },
      compaction: { version: 1 },
    });
  });
});

describe("Lody metadata helpers", () => {
  it("merges into _meta.lody without dropping provider keys", () => {
    expect(withLodyMeta({ claudeCode: { toolName: "Read" } }, { toolName: "Read" })).toEqual({
      claudeCode: { toolName: "Read" },
      lody: { toolName: "Read" },
    });
  });

  it("adds canonical tool identity alongside legacy Claude metadata", () => {
    expect(withLodyToolName({ claudeCode: { toolName: "Bash" } }, "Bash")).toEqual({
      claudeCode: { toolName: "Bash" },
      lody: { toolName: "Bash" },
    });
  });

  it("maps ACP statuses onto the core task lifecycle", () => {
    expect(toLodyTaskStatus("pending")).toBe("pending");
    expect(toLodyTaskStatus("in_progress")).toBe("in_progress");
    expect(toLodyTaskStatus("completed")).toBe("completed");
    expect(toLodyTaskStatus("failed")).toBe("failed");
    expect(toLodyTaskStatus("cancelled")).toBe("failed");
    expect(toLodyTaskStatus(undefined)).toBe("in_progress");
  });

  it("builds a task snapshot with epoch-second timestamps", () => {
    expect(
      buildLodyTaskMeta({
        taskId: "task-1",
        kind: "subagent",
        status: "completed",
        description: "  inspect repo  ",
        actor: "ZCode subagent",
        startedAt: "2026-01-02T03:04:05.000Z",
        endedAt: 1_767_326_646_000,
        usage: { totalTokens: 10, toolUses: 2, durationMs: 500 },
      }),
    ).toEqual({
      version: 1,
      taskId: "task-1",
      kind: "subagent",
      status: "completed",
      description: "inspect repo",
      actor: "ZCode subagent",
      startedAtEpochSeconds: 1_767_323_045,
      endedAtEpochSeconds: 1_767_326_646,
      usage: { totalTokens: 10, toolUses: 2, durationMs: 500 },
    });
  });
});

describe("Lody token usage", () => {
  it("renames backend counters and keeps unreported optional buckets absent", () => {
    expect(
      toLodyModelUsage(
        {
          inputTokens: 1200,
          outputTokens: 350,
          cacheReadTokens: 900,
          cacheWriteTokens: 120,
          reasoningTokens: 200,
          webSearchRequests: 0,
        },
        128_000,
      ),
    ).toEqual({
      inputTokens: 1200,
      outputTokens: 350,
      cacheReadInputTokens: 900,
      cacheCreationInputTokens: 120,
      reasoningOutputTokens: 200,
      webSearchRequests: 0,
      contextWindow: 128_000,
    });
  });

  it("omits optional buckets that the backend did not report", () => {
    expect(toLodyModelUsage({ inputTokens: 5, outputTokens: 6, cacheReadTokens: 0 })).toEqual({
      inputTokens: 5,
      outputTokens: 6,
      cacheReadInputTokens: 0,
    });
  });
});

describe("Lody rate limits", () => {
  const glm: QuotaResult = {
    kind: "success",
    level: "pro",
    items: [
      {
        key: "token_5h",
        label: "5h",
        usedPercent: 35,
        leftPercent: 65,
        nextResetTime: 1_767_400_000_000,
      },
      {
        key: "mcp",
        label: "MCP",
        usedPercent: 10,
        leftPercent: 90,
      },
    ],
  };
  const go: GoQueryResult = {
    kind: "success",
    fetchedAt: 1_767_300_000_000,
    rolling: { usagePercent: 5, resetInSec: 3600 },
    weekly: { usagePercent: 25, resetInSec: 86_400 },
    monthly: { usagePercent: 50, resetInSec: 2_592_000 },
  };

  it("maps GLM windows and Go windows into core rate-limit snapshots", () => {
    const snapshot = toLodyRateLimitsSnapshot(glm, go, 1_767_300_000_000);
    expect(snapshot.fetchedAtEpochSeconds).toBe(1_767_300_000);
    expect(snapshot.rateLimits).toEqual([
      {
        limitId: "glm:token_5h",
        scope: { providerId: "glm" },
        limitName: "5h",
        planName: "pro",
        windows: [
          {
            label: "5h",
            usedPercent: 35,
            windowDurationSeconds: 18_000,
            resetsAtEpochSeconds: 1_767_400_000,
          },
        ],
      },
      {
        limitId: "glm:mcp",
        scope: { providerId: "glm" },
        limitName: "MCP",
        planName: "pro",
        windows: [
          {
            label: "MCP",
            usedPercent: 10,
            windowDurationSeconds: null,
            resetsAtEpochSeconds: null,
          },
        ],
      },
      {
        limitId: "opencode-go",
        scope: { providerId: "opencode-go" },
        limitName: "Opencode Go",
        planName: null,
        windows: [
          {
            label: "5h",
            usedPercent: 5,
            windowDurationSeconds: 18_000,
            resetsAtEpochSeconds: 1_767_303_600,
          },
          {
            label: "Week",
            usedPercent: 25,
            windowDurationSeconds: 604_800,
            resetsAtEpochSeconds: 1_767_386_400,
          },
          {
            label: "Month",
            usedPercent: 50,
            windowDurationSeconds: 2_592_000,
            resetsAtEpochSeconds: 1_769_892_000,
          },
        ],
      },
    ]);
  });

  it("emits an empty rate-limit list when both providers are unavailable", () => {
    expect(
      toLodyRateLimitsSnapshot({ kind: "unavailable" }, { kind: "not_configured" }),
    ).toMatchObject({ rateLimits: [] });
  });
});
