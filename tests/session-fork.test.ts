/**
 * session/fork response-shape tests.
 *
 * The bridge historically exposed `session/fork` as a ZCode extension returning
 * only `forkedSessionId` and accepting `target`/`checkpointId`. ACP-spec clients
 * (Lody via `unstable_forkSession`) send `{ sessionId, cwd, mcpServers, _meta }`
 * and read `sessionId`. These tests lock the spec response while keeping the
 * extension response and checkpoint targeting intact.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/options.js", () => ({
  buildModes: vi.fn(async () => ({
    currentModeId: "yolo",
    availableModes: [{ id: "yolo", name: "YOLO" }],
  })),
  buildConfigOptions: vi.fn(async () => [
    {
      id: "model",
      name: "Model",
      type: "select",
      currentValue: "glm-5.3",
      options: [{ value: "glm-5.3", name: "GLM-5.3" }],
    },
  ]),
}));

import { fork } from "../src/handlers/extensions.js";
import { ZcodeAcpServer } from "../src/server.js";

class FakeBackend {
  isDead = false;
  calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  readonly listeners = new Map<string, unknown>();
  result: Record<string, unknown> = { forkedSessionId: "zcode-fork" };

  async request(
    id: number,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<{ id: number; result?: unknown; error?: { message: string } }> {
    this.calls.push({ method, params });
    if (method === "session/fork") return { id, result: this.result };
    return { id, result: {} };
  }

  registerEventListener(sessionId: string, listener: unknown): void {
    this.listeners.set(sessionId, listener);
  }
}

function makeServer(): { server: ZcodeAcpServer; backend: FakeBackend } {
  const server = new ZcodeAcpServer();
  server.registerSession("sess_acp", "sess_zcode");
  server.markBackendLoaded("sess_acp");
  server.sessionCwds.set("sess_acp", "/tmp/project");
  const backend = new FakeBackend();
  server.backend = backend as unknown as ZcodeAcpServer["backend"];
  return { server, backend };
}

describe("session/fork", () => {
  it("returns the ACP spec sessionId and the extension forkedSessionId", async () => {
    const { server, backend } = makeServer();
    const result = await fork(server, {
      sessionId: "sess_acp",
      cwd: "/tmp/project",
      mcpServers: [{ name: "mcp", command: "node", args: ["server.js"] }],
      _meta: { lody: { forkAtTurn: { version: 1, turnId: "turn-1" } } },
    });

    expect(result.sessionId).toBe("zcode-fork");
    expect(result.forkedSessionId).toBe("zcode-fork");
    expect(result.modes).toMatchObject({ currentModeId: "yolo" });
    expect(result.configOptions).toHaveLength(1);
    expect(server.resolveSid("zcode-fork")).toBe("zcode-fork");
    expect(server.sessionCwds.get("zcode-fork")).toBe("/tmp/project");

    const call = backend.calls.find((c) => c.method === "session/fork");
    expect(call?.params).toEqual({
      sessionId: "sess_zcode",
      target: { kind: "latestCheckpoint" },
    });
    expect(backend.listeners.has("zcode-fork")).toBe(true);
  });

  it("keeps checkpoint targeting for the ZCode extension callers", async () => {
    const { server, backend } = makeServer();
    await fork(server, {
      sessionId: "sess_acp",
      checkpointId: "checkpoint-7",
    });

    const call = backend.calls.find((c) => c.method === "session/fork");
    expect(call?.params).toEqual({
      sessionId: "sess_zcode",
      target: { kind: "checkpoint", checkpointId: "checkpoint-7" },
    });
  });

  it("accepts a backend that already returns the spec key", async () => {
    const { server, backend } = makeServer();
    backend.result = { sessionId: "zcode-fork-spec" };
    const result = await fork(server, { sessionId: "sess_acp", cwd: "/tmp/project" });
    expect(result.sessionId).toBe("zcode-fork-spec");
    expect(result.forkedSessionId).toBe("zcode-fork-spec");
  });

  it("fails when the backend returns no fork id", async () => {
    const { server, backend } = makeServer();
    backend.result = {};
    await expect(fork(server, { sessionId: "sess_acp" })).rejects.toThrow(/no session id/);
  });
});
