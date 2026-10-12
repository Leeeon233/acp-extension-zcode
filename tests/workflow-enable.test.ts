/**
 * Dynamic-workflow enable tests (desktop-host parity).
 *
 * With the gate resolved enabled, `dynamicWorkflowEnabled: true` must ride
 * every session/create and ALL FOUR session/resume construction sites
 * (session/resume, /resume adoption, session/load, eviction reload); with it
 * disabled or unresolved (null), the key must appear NOWHERE — the backend's
 * zod schemas are strict and flag-absent is the fail-closed default. The
 * process-wide policy push (`workspace/updateDynamicWorkflowPolicy`) is the
 * first enable channel: fired once with {enabled:true}, best-effort, with
 * -32601 (method absent on older backends) a logged no-op.
 *
 * The gate is pre-set on the server (`backendWorkflowGate`) instead of going
 * through a real ensureBackend spawn — that would launch the actual zcode
 * backend; the spawn-branch wiring is structural (server.ts).
 */

import type * as acp from "@agentclientprotocol/sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ZcodeBackend } from "../src/backend/client.js";
import type { ZcodeMessage } from "../src/backend/types.js";
import { pushDynamicWorkflowPolicy } from "../src/config/workflow-gate.js";
import {
  ensureRealSession,
  loadSession,
  reloadBackendSession,
  resumeIntoSession,
  resumeSession,
} from "../src/handlers/session.js";
import { ZcodeAcpServer } from "../src/server.js";

// The real module writes the App's ~/.zcode/v2/tasks-index.sqlite — never
// touch real disk in tests (same mock as session-lazy.test.ts).
vi.mock("../src/tasks-index.js", () => ({
  upsertSessionTask: async () => true,
  updateSessionTitle: async () => true,
}));

// In-memory durable alias store (src/lazy-sessions.ts persists to
// ~/.zcode/v2/acp-lazy-sessions.json — mocked for the same reason).
const mockStore = new Map<string, { cwd: string; zcodeSid?: string; createdAt: number }>();
vi.mock("../src/lazy-sessions.js", () => ({
  rememberLazySession: (acpSid: string, cwd: string) => {
    mockStore.set(acpSid, { cwd, createdAt: Date.now() });
  },
  recordMaterializedSession: (acpSid: string, zcodeSid: string, cwd: string) => {
    const existing = mockStore.get(acpSid);
    mockStore.set(acpSid, {
      cwd: existing?.cwd ?? cwd,
      zcodeSid,
      createdAt: existing?.createdAt ?? Date.now(),
    });
  },
  lookupLazySession: (acpSid: string) => mockStore.get(acpSid),
  lookupModelChoiceByZcodeSid: () => undefined,
}));

// Menu catch-up recorder: the deferred `/` menu re-send (cold-bridge gate
// catch-up in ensureRealSession) is captured instead of scheduled — the
// send-time filter output is what the assertions pin.
const menuSends = vi.hoisted(() => [] as Array<{ sid: string; names: string[] }>);
vi.mock("../src/handlers/io.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/handlers/io.js")>();
  return {
    ...actual,
    sendAvailableCommandsDeferred: (
      _registry: unknown,
      sid: string,
      commands: Array<{ name: string }>,
    ) => {
      menuSends.push({ sid, names: commands.map((c) => c.name) });
    },
  };
});

const GATE_ENABLED = Promise.resolve({
  mode: "alwaysOn" as const,
  enabled: true,
  source: "remote" as const,
});
const GATE_DISABLED = Promise.resolve({
  mode: "disabled" as const,
  enabled: false,
  source: "remote" as const,
});

/** Fake backend: records every request; answers the RPCs the flows need.
 * `rejectWorkflowMode` mimics a 0.16.9-era backend whose strict schema rejects
 * the 3.15.1 `dynamicWorkflowMode` key on the FIRST policy push. */
function fakeBackend(
  opts: { rejectWorkflowMode?: boolean } = {},
): ZcodeBackend & { calls: Array<{ method: string; params: unknown }> } {
  const calls: Array<{ method: string; params: unknown }> = [];
  let created = 0;
  let policyCalls = 0;
  const backend = {
    isDead: false,
    request: async (id: number, method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "workspace/updateDynamicWorkflowPolicy") {
        policyCalls += 1;
        if (opts.rejectWorkflowMode && policyCalls === 1) {
          return {
            id,
            error: { code: -32602, message: "Unrecognized key: dynamicWorkflowMode" },
          };
        }
        return { id, result: {} };
      }
      switch (method) {
        case "session/create":
          created += 1;
          return { id, result: { session: { sessionId: `sess_created_${created}`, title: "" } } };
        case "session/resume":
          return { id, result: {} };
        case "session/list":
          return { id, result: { sessions: [] } };
        case "session/read":
          return { id, result: { projection: { status: "idle" }, settings: {} } };
        case "session/messages":
          return { id, result: { messages: [] satisfies ZcodeMessage[] } };
        default:
          return { id, result: {} };
      }
    },
    registerEventListener: () => {},
    unregisterEventListener: () => {},
  } as unknown as ZcodeBackend;
  return { backend, calls };
}

/** Mock AgentContext that records every session/update notification. */
function mockContext(): { cx: acp.AgentContext; sent: unknown[] } {
  const sent: unknown[] = [];
  const cx = {
    notify(method: string, params: { sessionId: string; update: unknown }) {
      expect(method).toBe("session/update");
      sent.push(params.update);
      return Promise.resolve();
    },
  } as unknown as acp.AgentContext;
  return { cx, sent };
}

function makeServer(): {
  server: ZcodeAcpServer;
  calls: Array<{ method: string; params: unknown }>;
} {
  const server = new ZcodeAcpServer();
  const { backend, calls } = fakeBackend();
  server.backend = backend;
  return { server, calls };
}

beforeEach(() => {
  mockStore.clear();
});

describe("dynamic-workflow flag injection (gate enabled)", () => {
  it("session/create carries dynamicWorkflowEnabled:true (lazy materialization)", async () => {
    const { server, calls } = makeServer();
    server.backendWorkflowGate = GATE_ENABLED;
    server.pendingSessions.set("sess_acp", { cwd: "/tmp/ws" });

    await expect(ensureRealSession(server, "sess_acp")).resolves.toBe("sess_created_1");

    const create = calls.find((c) => c.method === "session/create");
    expect(create?.params).toMatchObject({
      workspace: { workspacePath: "/tmp/ws", workspaceKey: "/tmp/ws" },
      dynamicWorkflowEnabled: true,
    });
  });

  it("materialization re-sends the / menu after the gate settles enabled (cold-bridge catch-up)", async () => {
    const { server } = makeServer();
    server.backendWorkflowGate = GATE_ENABLED;
    server.allCommands = [
      { name: "workflow", description: "Dynamic workflow" },
      { name: "workflows", description: "List workflows" },
      { name: "quota", description: "Quota" },
    ];
    server.pendingSessions.set("sess_menu", { cwd: "/tmp/ws" });
    menuSends.length = 0;

    await expect(ensureRealSession(server, "sess_menu")).resolves.toBe("sess_created_1");

    const send = menuSends.find((s) => s.sid === "sess_menu");
    expect(send).toBeDefined();
    expect(send?.names).toContain("workflow");
    expect(send?.names).toContain("workflows");
    expect(send?.names).toContain("quota");
  });

  it("disabled gate → materialization sends no menu catch-up", async () => {
    const { server } = makeServer();
    server.backendWorkflowGate = GATE_DISABLED;
    server.allCommands = [{ name: "workflow", description: "Dynamic workflow" }];
    server.pendingSessions.set("sess_menu2", { cwd: "/tmp/ws" });
    menuSends.length = 0;

    await expect(ensureRealSession(server, "sess_menu2")).resolves.toBe("sess_created_1");
    expect(menuSends).toHaveLength(0);
  });

  it("session/resume carries dynamicWorkflowEnabled:true", async () => {
    const { server, calls } = makeServer();
    server.backendWorkflowGate = GATE_ENABLED;
    server.registerSession("sess_acp", "sess_zcode");
    server.sessionCwds.set("sess_acp", "/tmp/ws");
    const { cx } = mockContext();

    await resumeSession(server, { sessionId: "sess_acp" } as acp.ResumeSessionRequest, cx);

    const resumes = calls.filter((c) => c.method === "session/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0].params).toMatchObject({
      sessionId: "sess_zcode",
      dynamicWorkflowEnabled: true,
    });
  });

  it("session/load resume params carry dynamicWorkflowEnabled:true", async () => {
    const { server, calls } = makeServer();
    server.backendWorkflowGate = GATE_ENABLED;
    server.registerSession("sess_acp", "sess_zcode");
    server.sessionCwds.set("sess_acp", "/tmp/ws");
    const { cx } = mockContext();

    await loadSession(server, { sessionId: "sess_acp" } as acp.LoadSessionRequest, cx);

    const resumes = calls.filter((c) => c.method === "session/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0].params).toMatchObject({
      sessionId: "sess_zcode",
      dynamicWorkflowEnabled: true,
    });
  });

  it("/resume adoption (resumeIntoSession) carries dynamicWorkflowEnabled:true", async () => {
    const { server, calls } = makeServer();
    server.backendWorkflowGate = GATE_ENABLED;
    server.pendingSessions.set("sess_acp", { cwd: "/tmp/ws" });
    server.sessionCwds.set("sess_acp", "/tmp/ws");
    const { cx } = mockContext();

    const outcome = await resumeIntoSession(server, cx, "sess_acp", "sess_zcode");
    expect(outcome.ok).toBe(true);

    const resumes = calls.filter((c) => c.method === "session/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0].params).toMatchObject({
      sessionId: "sess_zcode",
      dynamicWorkflowEnabled: true,
    });
  });

  it("eviction/respawn reload (reloadBackendSession) carries dynamicWorkflowEnabled:true", async () => {
    const { server, calls } = makeServer();
    server.backendWorkflowGate = GATE_ENABLED;
    server.sessionCwds.set("sess_acp", "/tmp/ws");

    await reloadBackendSession(server, "sess_acp", "sess_zcode");

    const resumes = calls.filter((c) => c.method === "session/resume");
    expect(resumes).toHaveLength(1);
    expect(resumes[0].params).toMatchObject({
      sessionId: "sess_zcode",
      dynamicWorkflowEnabled: true,
    });
  });
});

describe("dynamic-workflow flag injection (gate disabled / unresolved)", () => {
  it("gate disabled: no dynamicWorkflowEnabled key anywhere in create/resume params", async () => {
    const { server, calls } = makeServer();
    server.backendWorkflowGate = GATE_DISABLED;
    server.pendingSessions.set("sess_create", { cwd: "/tmp/ws" });
    server.registerSession("sess_load", "sess_zcode_load");
    server.sessionCwds.set("sess_load", "/tmp/ws");
    const { cx } = mockContext();

    await ensureRealSession(server, "sess_create");
    await loadSession(server, { sessionId: "sess_load" } as acp.LoadSessionRequest, cx);

    expect(calls.some((c) => c.method === "session/create")).toBe(true);
    expect(calls.some((c) => c.method === "session/resume")).toBe(true);
    for (const c of calls) {
      expect(c.params).not.toHaveProperty("dynamicWorkflowEnabled");
    }
  });

  it("gate unresolved (null, pre-spawn): no dynamicWorkflowEnabled key", async () => {
    const { server, calls } = makeServer();
    server.pendingSessions.set("sess_acp", { cwd: "/tmp/ws" });

    await ensureRealSession(server, "sess_acp");

    const create = calls.find((c) => c.method === "session/create");
    expect(create?.params).toBeDefined();
    expect(create?.params).not.toHaveProperty("dynamicWorkflowEnabled");
  });
});

describe("pushDynamicWorkflowPolicy (process-wide enable channel)", () => {
  function recordingBackend(error?: { code?: number; message: string }): {
    target: Parameters<typeof pushDynamicWorkflowPolicy>[0];
    calls: Array<unknown[]>;
  } {
    const calls: Array<unknown[]> = [];
    const target = {
      request: async (
        id: number,
        method: string,
        params?: Record<string, unknown>,
        timeoutMs?: number,
      ) => {
        calls.push([id, method, params, timeoutMs]);
        return error ? { id, error } : { id, result: {} };
      },
    };
    return { target, calls };
  }

  it("sends workspace/updateDynamicWorkflowPolicy once with {workspace, enabled:true}", async () => {
    const { target, calls } = recordingBackend();
    let seq = 100;
    await pushDynamicWorkflowPolicy(target, () => ++seq, "/tmp/ws");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      101,
      "workspace/updateDynamicWorkflowPolicy",
      { workspace: { workspacePath: "/tmp/ws", workspaceKey: "/tmp/ws" }, enabled: true },
      10_000,
    ]);
  });

  it("-32601 (method absent) is a logged no-op — resolves, never throws", async () => {
    const { target } = recordingBackend({ code: -32601, message: "Method not found" });
    await expect(pushDynamicWorkflowPolicy(target, () => 1, "/tmp/ws")).resolves.toBe(false);
  });

  it("other error responses resolve best-effort", async () => {
    const { target } = recordingBackend({ code: -32000, message: "boom" });
    await expect(pushDynamicWorkflowPolicy(target, () => 1, "/tmp/ws")).resolves.toBe(false);
  });

  it("a thrown request resolves best-effort (backend gone mid-flight)", async () => {
    const target = {
      request: async () => {
        throw new Error("pipe broken");
      },
    };
    await expect(pushDynamicWorkflowPolicy(target, () => 1, "/tmp/ws")).resolves.toBe(false);
  });
});

describe("dynamicWorkflowMode pass-through (3.15.1 onDemand)", () => {
  const GATE_ONDEMAND = Promise.resolve({
    mode: "onDemand" as const,
    enabled: true,
    source: "remote" as const,
  });
  const flush = () => new Promise<void>((r) => setImmediate(r));

  it("carries the mode on the policy push and, once accepted, on create/resume", async () => {
    const { server, calls } = makeServer();
    server.backendWorkflowGate = GATE_ONDEMAND;
    server.pendingSessions.set("sess_od1", { cwd: "/tmp/ws" });
    await ensureRealSession(server, "sess_od1");
    await flush();
    server.pendingSessions.set("sess_od2", { cwd: "/tmp/ws" });
    await ensureRealSession(server, "sess_od2");
    await flush();
    server.pendingSessions.set("sess_od3", { cwd: "/tmp/ws" });
    await ensureRealSession(server, "sess_od3");

    const pushes = calls.filter((c) => c.method === "workspace/updateDynamicWorkflowPolicy");
    expect(pushes).toHaveLength(1); // once per generation per push shape
    expect(pushes[0].params).toMatchObject({ enabled: true, dynamicWorkflowMode: "onDemand" });

    const creates = calls.filter((c) => c.method === "session/create");
    expect(creates).toHaveLength(3);
    // Exactly when the accepted-push flag lands relative to the earlier
    // creates is microtask timing; the invariants are: every create stays
    // enabled, and the create AFTER the flush carries the mode.
    for (const c of creates) {
      expect(c.params).toMatchObject({ dynamicWorkflowEnabled: true });
    }
    expect(creates[2].params).toMatchObject({ dynamicWorkflowMode: "onDemand" });
  });

  it("old backend: unrecognized-key rejection retries boolean-only; create never carries the mode", async () => {
    const server = new ZcodeAcpServer();
    const { backend, calls } = fakeBackend({ rejectWorkflowMode: true });
    server.backend = backend;
    server.backendWorkflowGate = GATE_ONDEMAND;
    server.pendingSessions.set("sess_old1", { cwd: "/tmp/ws" });
    await ensureRealSession(server, "sess_old1");
    await flush();
    server.pendingSessions.set("sess_old2", { cwd: "/tmp/ws" });
    await ensureRealSession(server, "sess_old2");
    await flush();

    const pushes = calls.filter((c) => c.method === "workspace/updateDynamicWorkflowPolicy");
    expect(pushes).toHaveLength(2); // mode-carrying attempt + boolean-only retry
    expect(pushes[0].params).toHaveProperty("dynamicWorkflowMode");
    expect(pushes[1].params).not.toHaveProperty("dynamicWorkflowMode");
    expect(pushes[1].params).toMatchObject({ enabled: true });

    for (const c of calls.filter((x) => x.method === "session/create")) {
      expect(c.params).toMatchObject({ dynamicWorkflowEnabled: true });
      expect(c.params).not.toHaveProperty("dynamicWorkflowMode");
    }
    expect(server.workflowModeOnWire).toBe(false);
  });

  it("alwaysOn gate: the push stays boolean-only (implied default upstream)", async () => {
    const { server, calls } = makeServer();
    server.backendWorkflowGate = GATE_ENABLED;
    server.pendingSessions.set("sess_ao1", { cwd: "/tmp/ws" });
    await ensureRealSession(server, "sess_ao1");
    await flush();
    server.pendingSessions.set("sess_ao2", { cwd: "/tmp/ws" });
    await ensureRealSession(server, "sess_ao2");
    await flush();

    const pushes = calls.filter((c) => c.method === "workspace/updateDynamicWorkflowPolicy");
    expect(pushes).toHaveLength(1);
    expect(pushes[0].params).not.toHaveProperty("dynamicWorkflowMode");
    expect(pushes[0].params).toMatchObject({ enabled: true });
    for (const c of calls.filter((x) => x.method === "session/create")) {
      expect(c.params).not.toHaveProperty("dynamicWorkflowMode");
    }
  });
});

describe("guarded mode vs a pre-3.15 backend (create fallback)", () => {
  /** Fake backend whose mode enum rejects `guarded` (3.14.5-era zod text). */
  function guardedRejectingBackend(): ZcodeBackend & {
    calls: Array<{ method: string; params: unknown }>;
  } {
    const calls: Array<{ method: string; params: unknown }> = [];
    let created = 0;
    const backend = {
      isDead: false,
      request: async (id: number, method: string, params: unknown) => {
        calls.push({ method, params });
        if (method === "session/create" && (params as { mode?: string }).mode === "guarded") {
          return {
            id,
            error: {
              code: -32602,
              message:
                "Invalid enum value. Expected 'plan' | 'build' | 'edit' | 'yolo' | 'auto', received 'guarded'",
            },
          };
        }
        switch (method) {
          case "session/create":
            created += 1;
            return { id, result: { session: { sessionId: `sess_g_${created}`, title: "" } } };
          default:
            return { id, result: {} };
        }
      },
      registerEventListener: () => {},
      unregisterEventListener: () => {},
    } as unknown as ZcodeBackend;
    return { backend, calls };
  }

  it("retries session/create without the mode key when the enum rejects guarded", async () => {
    vi.stubEnv("ZCODE_ACP_MODE", "guarded");
    try {
      const server = new ZcodeAcpServer();
      const { backend, calls } = guardedRejectingBackend();
      server.backend = backend;
      server.pendingSessions.set("sess_guarded", { cwd: "/tmp/ws" });

      await expect(ensureRealSession(server, "sess_guarded")).resolves.toBe("sess_g_1");

      const creates = calls.filter((c) => c.method === "session/create");
      expect(creates).toHaveLength(2);
      expect(creates[0].params).toMatchObject({ mode: "guarded" });
      expect(creates[1].params).not.toHaveProperty("mode");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("a misconfigured mode is NOT rescued when the 3.15.1 enum merely lists guarded", async () => {
    // ZCODE_ACP_MODE is unvalidated; a typo must fail honestly even though the
    // 3.15.1 rejection text contains 'guarded' (in the EXPECTED list) — the
    // fallback may only fire for a create that actually SENT 'guarded'.
    vi.stubEnv("ZCODE_ACP_MODE", "planx");
    try {
      const server = new ZcodeAcpServer();
      const calls: Array<{ method: string; params: unknown }> = [];
      const backend = {
        isDead: false,
        request: async (id: number, method: string, params: unknown) => {
          calls.push({ method, params });
          if (method === "session/create") {
            return {
              id,
              error: {
                code: -32602,
                message:
                  "Invalid enum value. Expected 'plan' | 'build' | 'edit' | 'guarded' | 'yolo' | 'auto', received 'planx'",
              },
            };
          }
          return { id, result: {} };
        },
        registerEventListener: () => {},
        unregisterEventListener: () => {},
      } as unknown as ZcodeBackend;
      server.backend = backend;
      server.pendingSessions.set("sess_typo", { cwd: "/tmp/ws" });

      await expect(ensureRealSession(server, "sess_typo")).rejects.toThrow(/planx/);

      const creates = calls.filter((c) => c.method === "session/create");
      expect(creates).toHaveLength(1); // no silent mode-dropping retry
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
