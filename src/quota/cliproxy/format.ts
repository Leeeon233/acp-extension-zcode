/**
 * CLIProxyAPI quota rendering — one row per (account, model), tightest model
 * first, in the same bar style as the other sections so the combined card
 * reads as one piece. Only Gemini (`antigravity`) accounts render rows today;
 * other providers the proxy routes are summarised in a single trailing count
 * line (their passive quota fields follow a different, header-observed shape
 * and can join later without changing this layout).
 */

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
  for (const account of result.accounts) {
    for (const model of account.models) {
      const pct = roundTenth(model.used * 100);
      const reset = formatResetTime(model.resetAt);
      const trailing = reset ? ` · ${reset}` : "";
      const label = `${account.label} ${model.name}`.slice(0, 26);
      if (color) {
        const bar = renderColorBar(pct, { overlay: pickOverlay({ usedPercent: pct }) });
        body.push(`${label.padEnd(27)} ${bar}${trailing}`);
      } else {
        body.push(`${label.padEnd(27)} ${renderBar(pct)}  ${String(pct).padStart(2)}%${trailing}`);
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
