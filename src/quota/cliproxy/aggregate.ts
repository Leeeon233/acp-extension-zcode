/**
 * Cross-account aggregation for the CLIProxy card.
 *
 * Each antigravity subscription has its own quota pools; CLIProxy rotates
 * requests across them, so the actionable numbers are POOL-WIDE: total used
 * over total capacity (the average of the per-account used fractions — the
 * sum divided by the number of subscriptions reporting that family+window),
 * plus the earliest reset among the contributing buckets (when capacity
 * starts coming back). The per-account detail stays in
 * {@link ./types.js CpAccountQuota} for ACP consumers.
 */

import type { CpAccountQuota, CpWindow } from "./types.js";

/** One family's pool-wide window row. */
export interface CpFamilyWindow {
  window: CpWindow;
  /** Pool used fraction [0, 1] — Σ per-account used ÷ accounts reporting. */
  used: number;
  /** Earliest reset among the contributing accounts' buckets. */
  resetAt?: number;
}

/** One model family's aggregated rows, tightest window first. */
export interface CpFamilyAggregate {
  name: string;
  windows: CpFamilyWindow[];
}

/**
 * Aggregate every account's families into pool-wide rows. Families are keyed
 * by name (accounts report the same family set); a window reported by only
 * some accounts still divides by the reporting count — a subscription that
 * reports nothing for a family contributes neither usage nor capacity.
 */
export function aggregateCpFamilies(accounts: CpAccountQuota[]): CpFamilyAggregate[] {
  // family name → window → {usedSum, count, resetAt?}
  const families = new Map<string, Map<CpWindow, { usedSum: number; count: number; resetAt?: number }>>();
  for (const account of accounts) {
    for (const model of account.models) {
      let windows = families.get(model.name);
      if (!windows) {
        windows = new Map();
        families.set(model.name, windows);
      }
      for (const w of model.windows) {
        const agg = windows.get(w.window) ?? { usedSum: 0, count: 0 };
        agg.usedSum += w.used;
        agg.count += 1;
        if (w.resetAt !== undefined && (agg.resetAt === undefined || w.resetAt < agg.resetAt)) {
          agg.resetAt = w.resetAt;
        }
        windows.set(w.window, agg);
      }
    }
  }
  const out: CpFamilyAggregate[] = [];
  for (const [name, windows] of families) {
    const rows: CpFamilyWindow[] = [];
    for (const [window, agg] of windows) {
      rows.push({
        window,
        used: Math.min(1, agg.usedSum / agg.count),
        ...(agg.resetAt !== undefined && { resetAt: agg.resetAt }),
      });
    }
    // Tightest window first; ties keep the 5h-then-week display order.
    rows.sort((a, b) => b.used - a.used || windowOrder(a.window) - windowOrder(b.window));
    out.push({ name, windows: rows });
  }
  // Most-used family leads the card.
  return out.sort((a, b) => maxUsed(b) - maxUsed(a));
}

function windowOrder(window: CpWindow): number {
  return window === "5h" ? 0 : 1;
}

function maxUsed(family: CpFamilyAggregate): number {
  return family.windows.length > 0 ? family.windows[0]!.used : 0;
}

/**
 * The pool-wide binding row across ALL families: the single (window, used,
 * earliest reset) the dock and the ACP `combined` field report. The window is
 * whichever is fullest (max aggregated used over every family×window); the
 * reset is the earliest among that window's family rows — capacity starts
 * returning then even though the pool refills gradually.
 */
export function bindingCpWindow(families: CpFamilyAggregate[]): CpFamilyWindow | null {
  let binding: CpFamilyWindow | null = null;
  for (const family of families) {
    for (const w of family.windows) {
      if (!binding || w.used > binding.used) binding = { ...w };
    }
  }
  if (!binding) return null;
  // Earliest reset across every family reporting the SAME window.
  let earliest: number | undefined;
  for (const family of families) {
    for (const w of family.windows) {
      if (w.window === binding.window && w.resetAt !== undefined) {
        earliest = earliest === undefined ? w.resetAt : Math.min(earliest, w.resetAt);
      }
    }
  }
  return { ...binding, ...(earliest !== undefined && { resetAt: earliest }) };
}

/**
 * Per-window pool-wide rows for compact consumers (ACP `combined`): for each
 * window, the fullest family's aggregated used plus that window's earliest
 * reset. Families are separate pools, so a per-window sum would double-count
 * capacity; the fullest family is the binding constraint for that window.
 */
export function combinedCpWindows(families: CpFamilyAggregate[]): CpFamilyWindow[] {
  const rows = new Map<CpWindow, CpFamilyWindow>();
  const earliest: Partial<Record<CpWindow, number>> = {};
  for (const family of families) {
    for (const w of family.windows) {
      if (w.resetAt !== undefined) {
        earliest[w.window] =
          earliest[w.window] === undefined ? w.resetAt : Math.min(earliest[w.window]!, w.resetAt);
      }
      const prev = rows.get(w.window);
      if (!prev || w.used > prev.used) rows.set(w.window, { ...w });
    }
  }
  const out = [...rows.values()].map((w) => ({
    window: w.window,
    used: w.used,
    ...(earliest[w.window] !== undefined && { resetAt: earliest[w.window] }),
  }));
  out.sort((a, b) => b.used - a.used || windowOrder(a.window) - windowOrder(b.window));
  return out;
}
