/**
 * Lody extension bridge.
 *
 * Lody consumes provider-neutral capabilities from `acp-extension-core`:
 *  - `_meta.lody.*` metadata on standard ACP session updates
 *  - `_lody/...` JSON-RPC requests/notifications where ACP has no equivalent
 *
 * This module owns the capability advertisement, the metadata helpers, and
 * the usage/rate-limit serialisation so handlers stay free of Lody-specific
 * constants.
 */

import {
  LODY_EXTENSION_METHODS,
  SessionUsageAccumulator,
  type LodyActivityMeta,
  type LodyExtensionCapabilities,
  type LodyNotice,
  type LodyTaskMeta,
  type ModelUsage,
  type RateLimit,
  type RateLimitWindow,
  type RateLimitsSnapshot,
} from "acp-extension-core";

import { currentModelCached } from "./config/model-cache.js";
import { modelContextWindow, parseModelValue } from "./config/options.js";
import { queryCombined } from "./quota/combined.js";
import type { GoQueryResult } from "./quota/opencode-go/types.js";
import type { QuotaItem, QuotaResult } from "./quota/types.js";
import type { ZcodeAcpServer } from "./server.js";
import { log } from "./utils.js";

/** Advertised under `initialize.agentCapabilities._meta.lody`. */
export const LODY_AGENT_CAPABILITIES = {
  usage: { version: 1 },
  rateLimits: { version: 1, query: true },
  tasks: { version: 1, background: true },
  compaction: { version: 1 },
} as const satisfies LodyExtensionCapabilities;

export { LODY_EXTENSION_METHODS };

/** Metadata patch map for a single `_meta.lody` namespace. */
export type LodyMetaPatch = Record<string, unknown>;

/** True for plain records (used before mutating foreign metadata). */
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Add or merge fields under `_meta.lody` without dropping provider-specific
 * keys (`_meta.claudeCode`, `_meta.zcode`, …).
 */
export function withLodyMeta(
  meta: Record<string, unknown> | undefined,
  patch: LodyMetaPatch,
): Record<string, unknown> {
  const current = asRecord(meta?.["lody"]) ?? {};
  return { ...(meta ?? {}), lody: { ...current, ...patch } };
}

/** Attach the canonical Lody tool identity. */
export function withLodyToolName(
  meta: Record<string, unknown> | undefined,
  toolName: string,
): Record<string, unknown> {
  return withLodyMeta(meta, { toolName });
}

/** Attach a context-compaction / retry activity marker. */
export function withLodyActivity(
  meta: Record<string, unknown> | undefined,
  activity: LodyActivityMeta,
): Record<string, unknown> {
  return withLodyMeta(meta, { activity });
}

/** Attach a structured notice for the host (not persisted as agent text). */
export function withLodyNotice(
  meta: Record<string, unknown> | undefined,
  notice: LodyNotice,
): Record<string, unknown> {
  return withLodyMeta(meta, { notice });
}

/** Attach task lifecycle metadata. */
export function withLodyTask(
  meta: Record<string, unknown> | undefined,
  task: LodyTaskMeta,
): Record<string, unknown> {
  return withLodyMeta(meta, { task });
}

/** Map an ACP tool-call status to the core task lifecycle status. */
export function toLodyTaskStatus(status: string | undefined): LodyTaskMeta["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
    case "error":
    case "cancelled":
      return "failed";
    default:
      return "in_progress";
  }
}

/** Convert ISO/string/epoch-ms timestamp sources to Unix epoch seconds. */
export function epochSeconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Accept both seconds and milliseconds; ZCode timestamps are normally ISO
    // strings, but background payloads may already be numeric.
    return Math.floor(value > 1_000_000_000_000 ? value / 1000 : value);
  }
  if (typeof value === "string" && value.trim()) {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return Math.floor(ms / 1000);
  }
  return undefined;
}

function boundedText(value: unknown, max = 2_000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 3)}...`;
}

/** Build a task snapshot from loose background-task/tool payloads. */
export function buildLodyTaskMeta(input: {
  taskId: string;
  kind: LodyTaskMeta["kind"];
  status: LodyTaskMeta["status"];
  description?: unknown;
  actor?: unknown;
  parentTaskId?: unknown;
  parentToolCallId?: unknown;
  modelId?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  summary?: unknown;
  error?: unknown;
  lastToolName?: unknown;
  usage?: LodyTaskMeta["usage"];
  skipTranscript?: boolean;
}): LodyTaskMeta {
  const task: LodyTaskMeta = {
    version: 1,
    taskId: input.taskId,
    kind: input.kind,
    status: input.status,
  };
  const description = boundedText(input.description);
  if (description !== undefined) task.description = description;
  const actor = boundedText(input.actor, 200);
  if (actor !== undefined) task.actor = actor;
  const parentTaskId = boundedText(input.parentTaskId, 200);
  if (parentTaskId !== undefined) task.parentTaskId = parentTaskId;
  const parentToolCallId = boundedText(input.parentToolCallId, 200);
  if (parentToolCallId !== undefined) task.parentToolCallId = parentToolCallId;
  const modelId = boundedText(input.modelId, 200);
  if (modelId !== undefined) task.modelId = modelId;
  const started = epochSeconds(input.startedAt);
  if (started !== undefined) task.startedAtEpochSeconds = started;
  const ended = epochSeconds(input.endedAt);
  if (ended !== undefined) task.endedAtEpochSeconds = ended;
  const summary = boundedText(input.summary);
  if (summary !== undefined) task.summary = summary;
  const error = boundedText(input.error);
  if (error !== undefined) task.error = error;
  const lastToolName = boundedText(input.lastToolName, 200);
  if (lastToolName !== undefined) task.lastToolName = lastToolName;
  if (input.usage !== undefined) task.usage = input.usage;
  if (input.skipTranscript !== undefined) task.skipTranscript = input.skipTranscript;
  return task;
}

/** Map ZCode's merged turn usage onto the core per-model accounting shape. */
export function toLodyModelUsage(
  raw: Record<string, unknown> | null | undefined,
  contextWindow?: number,
): ModelUsage | undefined {
  if (!raw) return undefined;
  const count = (key: string): number => {
    const value = raw[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const optionalCount = (key: string): number | undefined => {
    const value = raw[key];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  };

  const usage: ModelUsage = {
    inputTokens: count("inputTokens"),
    outputTokens: count("outputTokens"),
    cacheReadInputTokens: count("cacheReadTokens"),
  };
  const cacheCreation = optionalCount("cacheWriteTokens");
  if (cacheCreation !== undefined) usage.cacheCreationInputTokens = cacheCreation;
  const reasoning = optionalCount("reasoningTokens");
  if (reasoning !== undefined) usage.reasoningOutputTokens = reasoning;
  const webSearch = optionalCount("webSearchRequests");
  if (webSearch !== undefined) usage.webSearchRequests = webSearch;
  if (contextWindow !== undefined && contextWindow > 0) usage.contextWindow = contextWindow;
  return usage;
}

/** Per-server usage accumulators keyed by backend session id. */
const usageAccumulators = new WeakMap<ZcodeAcpServer, Map<string, SessionUsageAccumulator>>();

function usageAccumulatorFor(server: ZcodeAcpServer, zcodeSid: string): SessionUsageAccumulator {
  let bySession = usageAccumulators.get(server);
  if (!bySession) {
    bySession = new Map();
    usageAccumulators.set(server, bySession);
  }
  let accumulator = bySession.get(zcodeSid);
  if (!accumulator) {
    accumulator = new SessionUsageAccumulator();
    bySession.set(zcodeSid, accumulator);
  }
  return accumulator;
}

/**
 * Publish one cumulative `_lody/session/usage_update`.
 *
 * `rawUsage` is the backend's merged per-turn usage object. The accumulator
 * makes repeated snapshots of the same operation id idempotent (and tolerates
 * late completion corrections), matching the core contract.
 */
export async function emitLodyUsageUpdate(
  server: ZcodeAcpServer,
  acpSid: string,
  zcodeSid: string,
  operationId: string,
  rawUsage: Record<string, unknown> | null | undefined,
): Promise<void> {
  if (!rawUsage || server.clients.size === 0) return;
  try {
    const encodedModel = await currentModelCached(server, zcodeSid);
    const { providerId, modelId } = parseModelValue(encodedModel);
    const contextWindow = modelContextWindow(providerId, modelId);
    const row = toLodyModelUsage(rawUsage, contextWindow > 0 ? contextWindow : undefined);
    if (!row) return;

    const update = usageAccumulatorFor(server, zcodeSid).update(zcodeSid, operationId, {
      [modelId || "unknown"]: row,
    });
    if (!update) return;

    const broadcast = server.clients.broadcast();
    for (const sid of server.sessionAliases(acpSid)) {
      await broadcast.notify(LODY_EXTENSION_METHODS.sessionUsageUpdate, {
        ...update,
        sessionId: sid,
      });
    }
  } catch (e) {
    log(`lody: usage_update failed (${e instanceof Error ? e.message : String(e)}); continuing`);
  }
}

function durationSecondsForQuotaItem(item: QuotaItem): number | null {
  const key = item.key.toLowerCase();
  const label = item.label.toLowerCase();
  if (key.includes("5h") || label.includes("5h")) return 5 * 60 * 60;
  if (key.includes("week") || label.includes("week")) return 7 * 24 * 60 * 60;
  if (key.includes("month") || label.includes("month")) return 30 * 24 * 60 * 60;
  return null;
}

function resetSecondsFromMs(nextResetTime: number | undefined): number | null {
  if (typeof nextResetTime !== "number" || !Number.isFinite(nextResetTime)) return null;
  return Math.floor(nextResetTime / 1000);
}

function toGlmRateLimits(result: QuotaResult): RateLimit[] {
  if (result.kind !== "success") return [];
  return result.items.map((item) => ({
    limitId: `glm:${item.key}`,
    scope: { providerId: "glm" },
    limitName: item.label,
    planName: result.level ?? null,
    windows: [
      {
        label: item.label,
        usedPercent: item.usedPercent,
        windowDurationSeconds: durationSecondsForQuotaItem(item),
        resetsAtEpochSeconds: resetSecondsFromMs(item.nextResetTime),
      },
    ],
  }));
}

function toGoRateLimits(result: GoQueryResult): RateLimit[] {
  if (result.kind !== "success") return [];
  const windows: RateLimitWindow[] = [];
  const fetchedAtEpochSeconds = Math.floor(result.fetchedAt / 1000);
  const addWindow = (
    label: string,
    duration: number,
    window: { usagePercent: number; resetInSec: number },
  ) => {
    windows.push({
      label,
      usedPercent: Math.min(100, Math.max(0, window.usagePercent)),
      windowDurationSeconds: duration,
      resetsAtEpochSeconds: fetchedAtEpochSeconds + Math.max(0, Math.floor(window.resetInSec)),
    });
  };
  addWindow("5h", 5 * 60 * 60, result.rolling);
  addWindow("Week", 7 * 24 * 60 * 60, result.weekly);
  if (result.monthly) addWindow("Month", 30 * 24 * 60 * 60, result.monthly);
  return [
    {
      limitId: "opencode-go",
      scope: { providerId: "opencode-go" },
      limitName: "Opencode Go",
      planName: null,
      windows,
    },
  ];
}

/** Convert the bridge's combined quota sources into the core snapshot. */
export function toLodyRateLimitsSnapshot(
  glm: QuotaResult,
  go: GoQueryResult,
  now = Date.now(),
): RateLimitsSnapshot {
  return {
    rateLimits: [...toGlmRateLimits(glm), ...toGoRateLimits(go)],
    fetchedAtEpochSeconds: Math.floor(now / 1000),
  };
}

/** Query GLM + Opencode Go and return the core rate-limit snapshot. */
export async function getLodyRateLimits(): Promise<RateLimitsSnapshot> {
  const { glm, go } = await queryCombined("all");
  return toLodyRateLimitsSnapshot(glm, go);
}

let lastRateLimitsPushAt = 0;
const RATE_LIMITS_PUSH_INTERVAL_MS = 60_000;

/** Best-effort proactive `_lody/rate_limits/update`, throttled per process. */
export async function emitLodyRateLimitsUpdate(server: ZcodeAcpServer): Promise<void> {
  if (server.clients.size === 0) return;
  const now = Date.now();
  if (now - lastRateLimitsPushAt < RATE_LIMITS_PUSH_INTERVAL_MS) return;
  lastRateLimitsPushAt = now;
  try {
    const snapshot = await getLodyRateLimits();
    await server.clients.broadcast().notify(LODY_EXTENSION_METHODS.rateLimitsUpdate, snapshot);
  } catch (e) {
    log(
      `lody: rate_limits_update failed (${e instanceof Error ? e.message : String(e)}); continuing`,
    );
  }
}

/** Test helper: reset the process-level rate-limit push throttle. */
export function resetLodyRateLimitsThrottleForTest(): void {
  lastRateLimitsPushAt = 0;
}
