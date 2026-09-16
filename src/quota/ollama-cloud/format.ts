/**
 * Ollama Cloud usage formatting.
 *
 * Renders the plan's usage windows as progress bars in the same style as the
 * GLM and Opencode Go sections, so all sections read as one card in the
 * combined view. Which windows exist depends on the account's plan: legacy
 * plans expose session (5h) + weekly; current credit plans expose monthly.
 * The API exposes no reset timestamps, so — unlike the other providers — the
 * lines carry no reset stamp, just the percent.
 */

import { pickOverlay, renderColorBar } from "../color.js";
import { renderBar } from "../format.js";
import { roundTenth } from "../rounding.js";
import type { OcQueryResult } from "./types.js";

/** Label + window metadata, in display order. Which rows appear depends on
 *  the account's plan: legacy plans carry session (5h) + weekly; current
 *  credit plans carry monthly only. */
const WINDOW_META: Array<{ key: "session" | "weekly" | "monthly"; label: string }> = [
  { key: "session", label: "5h" },
  { key: "weekly", label: "Week" },
  { key: "monthly", label: "Month" },
];

/** A rendered section: a header line and zero or more body lines. */
export interface RenderedSection {
  header: string;
  body: string[];
}

/**
 * Render the Ollama Cloud section.
 *
 * Used by the combined formatter. The header is always `Ollama Cloud`; body
 * has one bar line per window. Non-success kinds return a header + a single
 * explanatory line.
 *
 * When `color` is true the bar is a heat-colored 24-bit ANSI bar with the
 * percent overlaid inside, mirroring the other providers' color layout.
 */
export function formatOcSection(result: OcQueryResult, color = false): RenderedSection {
  const header = "Ollama Cloud";

  if (result.kind !== "success") {
    const msg =
      result.kind === "not_configured"
        ? "not configured (set OLLAMA_API_KEY)"
        : result.kind === "auth_error"
          ? "auth failed — check your Ollama API key"
          : "unavailable";
    return { header, body: [msg] };
  }

  const body = WINDOW_META.filter((m) => result[m.key] !== undefined).map((m) => {
    const fraction = result[m.key]!;
    const pct = roundTenth(fraction * 100);
    if (color) {
      const bar = renderColorBar(pct, { overlay: pickOverlay({ usedPercent: pct }) });
      return `${m.label.padEnd(5)} ${bar}`;
    }
    return `${m.label.padEnd(5)} ${renderBar(pct)}  ${String(pct).padStart(2)}%`;
  });

  return { header, body };
}
