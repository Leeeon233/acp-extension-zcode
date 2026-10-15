/**
 * CLIProxyAPI quota rendering — pool-wide rows: every Gemini subscription's
 * usage aggregated per model family and window (`5h` / `Week`), each row
 * stamped with that window's EARLIEST reset across accounts (when capacity
 * starts coming back). Same bar style as the other sections so the combined
 * card reads as one piece. Non-Gemini providers the proxy routes are
 * summarised in a single trailing count line.
 */

import { aggregateCpFamilies } from "./aggregate.js";
import { pickOverlay, renderColorBar } from "../color.js";
import { formatResetTime, renderBar } from "../format.js";
import { roundTenth } from "../rounding.js";
import type { CpQueryResult } from "./types.js";

/** `3m`-style age for the cached-stale header stamp. */
function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${minutes % 60 || ""}`;
  return `${minutes}m`;
}

function windowLabel(window: "5h" | "week"): string {
  return window === "5h" ? "5h" : "Week";
}

export function formatCpSection(
  result: CpQueryResult,
  color = false,
  /** Count of non-Gemini accounts routed by the proxy, for the tail line. */
  otherAccounts = 0,
  /** Clock for the cached-age stamp (tests inject; default real time). */
  now: () => number = () => Date.now(),
): { header: string; body: string[] } {
  // The section's 5-minute server-side-of-the-card TTL means values can lag
  // the rest of the card by minutes (see ../index.js TTL_MS) — stamp the age
  // so a motionless number reads as cached, not broken.
  const ageMs = result.kind === "success" ? now() - result.fetchedAt : 0;
  const header = ageMs > 90_000 ? `CLIProxy · ${formatAge(ageMs)} old` : "CLIProxy";
  if (result.kind !== "success") {
    const msg =
      result.kind === "not_configured"
        ? "not configured (set quota.cliproxyUrl + quota.cliproxyManagementKey)"
        : result.kind === "auth_error"
          ? "auth failed — check the management key"
          : "unavailable";
    return { header, body: [msg] };
  }
  if (result.accounts.length === 0) {
    return { header, body: ["no Gemini accounts on this proxy"] };
  }
  const body: string[] = [];
  for (const family of aggregateCpFamilies(result.accounts)) {
    const label = family.name.slice(0, 22);
    for (const [index, w] of family.windows.entries()) {
      const pct = roundTenth(w.used * 100);
      // Continuation rows (2nd window, 2nd family…) indent under the label.
      const name = index === 0 ? label.padEnd(22) : " ".repeat(22);
      const window = windowLabel(w.window).padEnd(5);
      const reset = formatResetTime(w.resetAt);
      const trailing = reset ? ` · ${reset}` : "";
      if (color) {
        const bar = renderColorBar(pct, { overlay: pickOverlay({ usedPercent: pct }) });
        body.push(`${name}${window}${bar}${trailing}`);
      } else {
        body.push(`${name}${window}${renderBar(pct)}  ${String(pct).padStart(2)}%${trailing}`);
      }
    }
  }
  if (body.length === 0) {
    return { header, body: ["no quota buckets reported"] };
  }
  if (otherAccounts > 0) {
    body.push(`      + ${otherAccounts} non-Gemini account${otherAccounts > 1 ? "s" : ""}`);
  }
  return { header, body };
}
