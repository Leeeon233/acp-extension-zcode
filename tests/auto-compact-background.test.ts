/**
 * Detached auto-compact (the compaction kill-chain fix): the armed turn's
 * response returns and running:false lands BEFORE the compaction finishes;
 * the finished turn is out of pendingTurns (nothing for cancel/preempt to
 * kill); a follow-up prompt during the compaction waits on the busy-retry
 * (one waiting notice, no stop pair, no drain-gate close escalation) and
 * proceeds once the compaction settles.
 *
 * Mock layout mirrors tests/turn-state.test.ts, plus compaction controls:
 * session/read reports a HIGH contextUsed on the first read only (the
 * post-compaction refresh and later turns read low), session/goal show
 * reports the lock held until releaseGoal(), and follow-up session/sends
 * are busy (1308) while that lock is held.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeEvent } from "../src/backend/types.js";
import { prompt } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

/** cx recording turnState payloads and agent_message_chunk texts. */
function collectCx(): {
  cx: acp.AgentContext;
  turnStates: Array<{ sessionId: string; running: boolean }>;
  texts: string[];
} {
  const turnStates: Array<{ sessionId: string; running: boolean }> = [];
  const texts: string[] = [];
  const cx = {
    notify: async (method: string, params: Record<string, unknown>) => {
      if (method === "$/zcode/turnState") {
        turnStates.push(params as { sessionId: string; running: boolean });
      } else if (method === "session/update") {
        const u = (
          params as {
            update?: { sessionUpdate?: string; content?: { text?: string } };
          }
        ).update;
        if (u?.sessionUpdate === "agent_message_chunk") texts.push(u.content?.text ?? "");
      }
    },
    request: async () => ({}),
  } as unknown as acp.AgentContext;
  return { cx, turnStates, texts };
}

interface SentFrame {
  method: string;
}

function makeBackend(): {
  backend: ZcodeBackend;
  counts: Map<string, number>;
  sentFrames: SentFrame[];
  releaseGoal: () => void;
} {
  const counts = new Map<string, number>();
  const sentFrames: SentFrame[] = [];
  const listeners: Array<{ handleEvent: (e: ZcodeEvent) => void }> = [];
  let goalLock = true;
  let sendCount = 0;
  const bump = (m: string) => counts.set(m, (counts.get(m) ?? 0) + 1);
  const deliver = (events: ZcodeEvent[]) => {
    for (const e of events) for (const l of listeners) l.handleEvent(e);
  };
  const backend = {
    isDead: false,
    request: async (_id: number, method: string) => {
      bump(method);
      switch (method) {
        case "workspace/updateProviderRegistry":
        case "session/resume":
        case "session/subscribe":
          return { result: {} };
        case "session/read":
          return {
            result: {
              projection: {
                status: "idle",
                // Usage is HIGH until the compaction settles, LOW after —
                // turn 1's arming read trips the threshold; the post-compact
                // refresh and any later turn read the compacted usage.
                contextUsed: goalLock ? 150_000 : 1_000,
              },
              settings: {},
            },
          };
        case "session/messages":
          return { result: { messages: [] } };
        case "session/compact":
          return { result: {} };
        case "session/goal":
          return goalLock
            ? { error: { code: -32000, message: "prompt is running" } }
            : { result: {} };
        case "session/send": {
          sendCount++;
          if (sendCount > 1 && goalLock) {
            return { error: { code: 1308, message: "prompt is running" } };
          }
          deliver([
            { type: "turn.started" },
            { type: "turn.completed", payload: { resultType: "success" } },
          ]);
          return { result: { accepted: true } };
        }
        default:
          return { error: { message: `unhandled ${method}` } };
      }
    },
    send: (method: string) => {
      sentFrames.push({ method });
    },
    pollServerRequests: () => [],
    registerEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      listeners.push(l);
    },
    unregisterEventListener: (_sid: string, l: { handleEvent: (e: ZcodeEvent) => void }) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  } as unknown as ZcodeBackend;
  return { backend, counts, sentFrames, releaseGoal: () => (goalLock = false) };
}

/** Server with a pre-registered, backend-loaded session (no create/resume). */
function setup(backend: ZcodeBackend): ZcodeAcpServer {
  const server = new ZcodeAcpServer();
  server.backend = backend;
  server.registerSession("sess_ac", "zs_ac");
  server.markBackendLoaded("sess_ac");
  return server;
}

function promptParams(): acp.PromptRequest {
  return { sessionId: "sess_ac", prompt: [{ type: "text", text: "hello" }] } as acp.PromptRequest;
}

/** Raw backend frames that would kill a generation — must stay empty here. */
const KILL_METHODS = ["v4/command", "session/stop", "session/close"];
const killFrames = (frames: SentFrame[]) => frames.filter((f) => KILL_METHODS.includes(f.method));

beforeEach(() => {
  vi.stubEnv("ZCODE_ACP_LANG", "en");
  vi.stubEnv("ZCODE_ACP_AUTO_COMPACT_THRESHOLD", "100000");
});

describe("detached auto-compact", () => {
  it("returns the response and settles running:false BEFORE the compaction; the finished turn leaves nothing to preempt", async () => {
    const { backend, counts, sentFrames, releaseGoal } = makeBackend();
    const server = setup(backend);
    const { cx, turnStates } = collectCx();

    const result = await prompt(server, promptParams(), cx, 1);

    // The response returned while the compaction still holds the probe lock —
    // the pre-fix shape parked here for the whole compaction.
    expect(result).toEqual({ stopReason: "end_turn" });
    expect(turnStates).toEqual([
      { sessionId: "sess_ac", running: true },
      { sessionId: "sess_ac", running: false },
    ]);
    expect(server.pendingTurns.size).toBe(0);

    // The detached compaction started: threshold read → session/compact.
    await vi.waitFor(() => expect(counts.get("session/compact")).toBe(1));
    expect(server.autoCompactInFlight.has("zs_ac")).toBe(true);
    // Nothing fired a stop or close — the kill chain is disarmed.
    expect(killFrames(sentFrames)).toEqual([]);

    // Settle the compaction so no probe loop outlives the test (the settle
    // path waits out one 2s probe gap, so the default 1s waitFor is short).
    releaseGoal();
    await vi.waitFor(() => expect(server.autoCompactInFlight.has("zs_ac")).toBe(false), {
      timeout: 10_000,
    });
  }, 15_000);

  it("a follow-up prompt during the compaction waits (one notice, no kill) and proceeds after it settles", async () => {
    const { backend, counts, sentFrames, releaseGoal } = makeBackend();
    const server = setup(backend);
    const { cx, turnStates, texts } = collectCx();

    await prompt(server, promptParams(), cx, 1); // turn 1 + detached compaction
    await vi.waitFor(() => expect(counts.get("session/compact")).toBe(1));

    const p2 = prompt(server, promptParams(), cx, 2);
    // The follow-up hits the busy lock and shows the waiting notice.
    await vi.waitFor(() =>
      expect(
        texts.filter((t) => t.includes("auto-compact in progress")).length,
      ).toBeGreaterThanOrEqual(1),
    );
    // No preempt victim, no stop pair, no drain-gate close escalation.
    expect(killFrames(sentFrames)).toEqual([]);

    releaseGoal();
    const r2 = await p2;
    expect(r2).toEqual({ stopReason: "end_turn" });
    expect(turnStates).toEqual([
      { sessionId: "sess_ac", running: true }, // turn 1 starts
      { sessionId: "sess_ac", running: false }, // turn 1 settles BEFORE the compaction
      { sessionId: "sess_ac", running: true }, // turn 2 starts (waits in send-retry)
      { sessionId: "sess_ac", running: false }, // turn 2 completes
    ]);
    // Compaction settled and the flag cleared; turn 2's own threshold read
    // (post-compaction usage) did not re-arm a second compaction.
    await vi.waitFor(() => expect(server.autoCompactInFlight.has("zs_ac")).toBe(false));
    expect(counts.get("session/compact")).toBe(1);
    // The waiting notice fired exactly once across all send retries.
    expect(texts.filter((t) => t.includes("auto-compact in progress"))).toHaveLength(1);
  }, 20_000);
});
