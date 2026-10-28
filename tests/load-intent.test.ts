/**
 * session/load intent gate (ADR-0006 follow-up): a client reconnect ladder's
 * AUTO load of a remotely closed conversation replays history but must not
 * re-arm discovery — otherwise the bridge re-advertises the sid, the
 * heartbeat reports it, and the hub clears the close tombstone group: the
 * conversation resurrects on every surface and the auto-409 gate disarms
 * with it. The client cannot see any of this server-side state, so the
 * response discloses the suppression via `_meta.zcode.sessionClosed`.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import { readLoadIntent } from "../src/handlers/replay.js";
import { loadSession } from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

function fakeBackend(): ZcodeBackend {
  return {
    isDead: false,
    request: async (_id: number, method: string) => {
      switch (method) {
        case "workspace/updateProviderRegistry":
        case "session/resume":
          return { result: {} };
        case "session/subscribe":
          return { result: { eventSeq: 0 } };
        case "session/read":
          return { result: { projection: { status: "idle" }, todos: [] } };
        case "session/messages":
          return {
            result: {
              messages: [
                { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "hi" }] },
              ],
            },
          };
        default:
          return { result: {} };
      }
    },
    send: () => {},
    pollServerRequests: () => [],
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
}

/** cx that records every session/update notification. */
function collectCx(): { cx: acp.AgentContext; updates: unknown[] } {
  const updates: unknown[] = [];
  const cx = {
    notify: async (_method: string, params: Record<string, unknown>) => {
      updates.push(params);
    },
  } as unknown as acp.AgentContext;
  return { cx, updates };
}

const load = (sid: string, meta?: Record<string, unknown>) =>
  ({ sessionId: sid, ...(meta ? { _meta: meta } : {}) }) as acp.LoadSessionRequest;

const sessionClosedOf = (res: acp.LoadSessionResponse): boolean | undefined =>
  (res as { _meta?: { zcode?: { sessionClosed?: boolean } } })._meta?.zcode?.sessionClosed;

describe("readLoadIntent", () => {
  it('defaults to "user"; only the exact "auto" string counts', () => {
    expect(readLoadIntent(load("s"))).toBe("user");
    expect(readLoadIntent(load("s", {}))).toBe("user");
    expect(readLoadIntent(load("s", { zcode: { intent: "Auto" } }))).toBe("user");
    expect(readLoadIntent(load("s", { zcode: { intent: "user" } }))).toBe("user");
    expect(readLoadIntent(load("s", { zcode: { intent: "auto" } }))).toBe("auto");
  });
});

describe("session/load intent gate", () => {
  it("an AUTO load of a retired session replays history, stays retired, discloses sessionClosed", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend();
    server.registerSession("s1", "sess_1");
    server.retireDiscovery("s1");
    const { cx, updates } = collectCx();

    const res = await loadSession(server, load("s1", { zcode: { intent: "auto" } }), cx);

    // History still replayed — the ladder asked for its transcript.
    expect(updates.length).toBeGreaterThan(0);
    // …but discovery stays retired: the summary stays INACTIVE (registerSession
    // re-seeds an inactive entry; only hasActivity advertises on the
    // heartbeat, so the hub tombstone survives), stamp intact.
    expect(server.sessionSummaries.get("s1")?.hasActivity ?? false).toBe(false);
    expect(server.isDiscoveryRetired("s1")).toBe(true);
    expect(sessionClosedOf(res)).toBe(true);
  });

  it("a USER load (the default) of a retired session re-arms as before — no flag", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend();
    server.registerSession("s1", "sess_1");
    server.retireDiscovery("s1");
    const { cx } = collectCx();

    const res = await loadSession(server, load("s1"), cx);

    expect(server.sessionSummaries.get("s1")?.hasActivity).toBe(true);
    expect(server.isDiscoveryRetired("s1")).toBe(false);
    expect(sessionClosedOf(res)).toBeUndefined();
  });

  it("an AUTO load of a LIVE session re-arms normally — auto never suppresses an open conversation", async () => {
    const server = new ZcodeAcpServer();
    server.backend = fakeBackend();
    server.registerSession("s1", "sess_1");
    const { cx } = collectCx();

    const res = await loadSession(server, load("s1", { zcode: { intent: "auto" } }), cx);

    expect(server.sessionSummaries.get("s1")?.hasActivity).toBe(true);
    expect(sessionClosedOf(res)).toBeUndefined();
  });
});
