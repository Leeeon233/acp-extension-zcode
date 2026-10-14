/**
 * Quota threshold push warnings (§5.7): edge-triggered tiers (60/80/90/95/98/100)
 * per watched window, drop-below-60 re-arm, persisted state surviving process
 * restarts (disk is re-read every check, serialized by the shared file lock),
 * the notify switch muting the push without freezing the state, and the
 * cross-process single-push guarantee (concurrent checks of one crossing).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const h = vi.hoisted(() => ({
  cfg: null as {
    contentDetail: "full" | "minimal";
    notify: Record<string, boolean>;
    quietMs?: number;
  } | null,
}));
vi.mock("../src/push/config.js", async (orig) => {
  const actual = await orig<typeof import("../src/push/config.js")>();
  return { ...actual, pushActive: () => h.cfg !== null, pushConfig: () => h.cfg };
});
vi.mock("../src/crash-guards.js", async (orig) => {
  const actual = await orig<typeof import("../src/crash-guards.js")>();
  return { ...actual, appendDiary: () => undefined };
});

const { checkQuotaThresholds, quotaTier, resetQuotaThresholdsForTest } =
  await import("../src/quota/thresholds.js");
const { setPushSenderForTests, resetPushSenderForTests } = await import("../src/push/push.js");
import type { QuotaItem, QuotaResult } from "../src/quota/types.js";

const pushes: string[] = [];
const stateFile = path.join(
  process.env.HOME ?? "",
  ".config",
  "zcode-acp",
  "quota-push-state.json",
);

function item(key: string, usedPercent: number, nextResetTime?: number): QuotaItem {
  return {
    key,
    label: key === "token_week" ? "Week" : "5h",
    usedPercent,
    leftPercent: 100 - usedPercent,
    ...(nextResetTime !== undefined ? { nextResetTime } : {}),
  };
}

function result(...items: QuotaItem[]): QuotaResult {
  return { kind: "success", level: "PRO", items };
}

beforeEach(() => {
  h.cfg = {
    contentDetail: "full",
    notify: {
      turn: true,
      goal: true,
      run: true,
      task: true,
      compact: true,
      ask: true,
      workflowStage: true,
      quota: true,
    },
    quietMs: 0,
  };
  pushes.length = 0;
  resetQuotaThresholdsForTest();
  rmSync(stateFile, { force: true });
  rmSync(`${stateFile}.lock`, { recursive: true, force: true });
  setPushSenderForTests({
    sendText: async (c) => {
      pushes.push(c);
    },
  });
});

afterEach(() => {
  resetPushSenderForTests();
  h.cfg = null;
});

describe("quotaTier", () => {
  it("maps percentages onto the 60/80/90/95/98/100 tiers", () => {
    expect(quotaTier(59.9)).toBe(0);
    expect(quotaTier(60)).toBe(60);
    expect(quotaTier(79.9)).toBe(60);
    expect(quotaTier(80)).toBe(80);
    expect(quotaTier(89.9)).toBe(80);
    expect(quotaTier(90)).toBe(90);
    expect(quotaTier(94.9)).toBe(90);
    expect(quotaTier(95)).toBe(95);
    expect(quotaTier(97.9)).toBe(95);
    expect(quotaTier(98)).toBe(98);
    expect(quotaTier(99.9)).toBe(98);
    expect(quotaTier(100)).toBe(100);
  });
});

describe("checkQuotaThresholds", () => {
  it("pushes each newly-crossed tier once; a drop re-arms the window", async () => {
    const reset = Date.now() + 3 * 3600_000;
    await checkQuotaThresholds(result(item("token_5h", 61))); // tier 60
    await checkQuotaThresholds(result(item("token_5h", 70))); // same tier — silent
    await checkQuotaThresholds(result(item("token_5h", 81))); // tier 80
    await checkQuotaThresholds(result(item("token_5h", 85))); // same tier — silent
    await checkQuotaThresholds(result(item("token_5h", 91, reset))); // tier 90
    await checkQuotaThresholds(result(item("token_5h", 93))); // same tier — silent
    await checkQuotaThresholds(result(item("token_5h", 96))); // tier 95
    await checkQuotaThresholds(result(item("token_5h", 99))); // tier 98
    await checkQuotaThresholds(result(item("token_5h", 100)));
    await checkQuotaThresholds(result(item("token_5h", 12))); // new window — re-arm
    await checkQuotaThresholds(result(item("token_5h", 82))); // fires again

    expect(pushes).toHaveLength(7);
    expect(pushes[0]).toContain("5h quota 61% used");
    expect(pushes[1]).toContain("5h quota 81% used");
    expect(pushes[2]).toContain("5h quota 91% used");
    expect(pushes[2]).toContain(`resets `);
    expect(pushes[3]).toContain("5h quota 96% used");
    expect(pushes[4]).toContain("5h quota 99% used");
    expect(pushes[5]).toContain("5h quota exhausted");
    expect(pushes[6]).toContain("5h quota 82% used");
  });

  it("tracks the weekly window independently and ignores non-budget keys", async () => {
    await checkQuotaThresholds(result(item("token_week", 85), item("mcp", 95), item("token", 99)));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("weekly quota 85% used");
  });

  it("persisted state survives a process restart (no re-push per rebirth)", async () => {
    await checkQuotaThresholds(result(item("token_5h", 81)));
    expect(pushes).toHaveLength(1);

    // A reborn hub/bridge: disk state is the only state, re-read per check.
    resetQuotaThresholdsForTest();
    await checkQuotaThresholds(result(item("token_5h", 83)));
    expect(pushes).toHaveLength(1); // still tier-80 — no duplicate

    await checkQuotaThresholds(result(item("token_5h", 92)));
    expect(pushes).toHaveLength(2);
    expect(pushes[1]).toContain("5h quota 92% used");
  });

  it("two concurrent checks of one crossing push once (hub + bridge race)", async () => {
    // Live shape of the 2026-10-14 report: hub and a bridge funneled the same
    // fresh fetch ~80ms apart. The lock serializes read→advance→persist, so
    // the second checker re-reads the advanced tier and stays silent.
    await Promise.all([
      checkQuotaThresholds(result(item("token_5h", 61))),
      checkQuotaThresholds(result(item("token_5h", 61))),
    ]);
    expect(pushes).toHaveLength(1);
  });

  it("a foreign process's persisted tier suppresses this check (disk is the truth)", async () => {
    // A sibling bridge already persisted tier 80 while this process had no
    // state of its own — the stale-mirror bug re-pushed the crossing.
    writeFileSync(stateFile, JSON.stringify({ items: { token_5h: 80 } }));
    await checkQuotaThresholds(result(item("token_5h", 85))); // tier 80 ≤ 80 — silent
    expect(pushes).toHaveLength(0);
    await checkQuotaThresholds(result(item("token_5h", 91))); // tier 90 — fires
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("5h quota 91% used");
  });

  it("notify.quota=false mutes the push but the tier state still advances", async () => {
    h.cfg = { ...h.cfg!, notify: { ...h.cfg!.notify, quota: false } };
    await checkQuotaThresholds(result(item("token_5h", 81)));
    expect(pushes).toHaveLength(0);

    // Re-enabled later: the 80 crossing does NOT replay; only the next tier fires.
    h.cfg = { ...h.cfg!, notify: { ...h.cfg!.notify, quota: true } };
    await checkQuotaThresholds(result(item("token_5h", 91)));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain("5h quota 91% used");
  });

  it("touching nothing when push is inactive — not even the state file", async () => {
    h.cfg = null;
    await checkQuotaThresholds(result(item("token_5h", 100)));
    expect(pushes).toHaveLength(0);
    expect(existsSync(stateFile)).toBe(false);
  });

  it("non-success results are a no-op", async () => {
    await checkQuotaThresholds({ kind: "unavailable" });
    await checkQuotaThresholds({ kind: "auth_error" });
    expect(pushes).toHaveLength(0);
  });
});
