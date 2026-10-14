/**
 * Parsers for the two CLIProxyAPI response shapes. Both are reconstructed
 * from the v8.0.28 source + CPAMC web-UI readers (undocumented on the wire) —
 * every field is read defensively: missing/odd shapes degrade to empty, never
 * throw. The management API accepts both camelCase and snake_case INPUT, but
 * its OUTPUT spelling is not contractual, so both variants are read.
 */

import type { CpAccountQuota, CpModelQuota } from "./types.js";

/** Antigravity accounts' provider id in the credentials listing (CPAMC's own
 *  quota support is antigravity-only — there is no separate gemini provider). */
export const ANTIGRAVITY_PROVIDER = "antigravity";

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A parsed credential entry — only the fields the quota flow needs. */
export interface CpCredentialEntry {
  authIndex: string;
  provider: string;
  label: string;
  projectId?: string;
}

/**
 * Parse the credentials listing. The response is an array of entries (the
 * field-carrying object may nest one level under `auth_files`/`credentials`/
 * `files` on some builds), each with `auth_index`/`authIndex` and
 * `provider`. The Gemini quota relay needs the account's CloudCode project
 * id: `file.project_id` → `metadata` → `attributes` → the entry itself
 * (CPAMC's resolution ladder).
 */
export function parseCredentialEntries(text: string): CpCredentialEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  let arr: unknown[] | null = Array.isArray(parsed) ? parsed : null;
  if (!arr) {
    const doc = asRecord(parsed);
    if (doc) {
      for (const key of ["auth_files", "credentials", "files", "data"]) {
        if (Array.isArray(doc[key])) {
          arr = doc[key] as unknown[];
          break;
        }
      }
    }
  }
  if (!arr) return [];
  const entries: CpCredentialEntry[] = [];
  for (const raw of arr) {
    const e = asRecord(raw);
    if (!e) continue;
    const authIndex = str(e.auth_index ?? e.authIndex ?? e.id);
    const provider = str(e.provider ?? e.type) ?? "";
    if (!authIndex) continue;
    const file = asRecord(e.file);
    const metadata = asRecord(e.metadata);
    const attributes = asRecord(e.attributes);
    const email =
      str(file?.email) ?? str(metadata?.email) ?? str(attributes?.email) ?? str(e.email);
    entries.push({
      authIndex,
      provider,
      label: email ? email.split("@")[0]! : authIndex,
      projectId:
        str(file?.project_id ?? file?.projectId) ??
        str(metadata?.project_id ?? metadata?.projectId) ??
        str(attributes?.project_id ?? attributes?.projectId) ??
        str(e.project_id ?? e.projectId),
    });
  }
  return entries;
}

/**
 * Parse one relayed `retrieveUserQuotaSummary` body into per-model rows.
 *
 * Two shapes, both read defensively (missing/odd fields degrade to empty,
 * never throw):
 * - antigravity (the shape live servers answer, CPAMC `builders.ts`):
 *   `{groups: [{displayName, buckets: [{window, remainingFraction,
 *   resetTime, …}]}]}` — each group is a model family ("Gemini Models",
 *   "Claude and GPT models") with one bucket per window.
 * - legacy flat `{models: [{name, buckets […]}]}` kept as a fallback.
 *
 * Each row carries several buckets (windows); we surface only the TIGHTEST
 * (lowest remaining) as `used`, the one the user actually hits first.
 */
export function parseQuotaSummary(bodyText: string): CpModelQuota[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return [];
  }
  const doc = asRecord(parsed);
  if (!doc) return [];
  if (Array.isArray(doc.groups)) return rowsFromGroups(doc.groups);
  if (Array.isArray(doc.models)) return rowsFromModels(doc.models);
  return [];
}

/** The tightest (max used) valid bucket, or null when none parses. */
function tightestBucket(bucketsRaw: unknown): { used: number; resetAt?: number } | null {
  if (!Array.isArray(bucketsRaw)) return null;
  let tightest: { used: number; resetAt?: number } | null = null;
  for (const bRaw of bucketsRaw) {
    const b = asRecord(bRaw);
    if (!b) continue;
    const remaining = num(b.remainingFraction ?? b.remaining_fraction);
    if (remaining === undefined || remaining < 0 || remaining > 1) continue;
    const used = 1 - remaining;
    if (!tightest || used > tightest.used) {
      const resetRaw = str(b.resetTime ?? b.reset_time);
      const resetAt = resetRaw !== undefined ? Date.parse(resetRaw) : Number.NaN;
      tightest = {
        used,
        ...(Number.isFinite(resetAt) && { resetAt }),
      };
    }
  }
  return tightest;
}

/** Antigravity shape: one row per group, named by its display name. */
function rowsFromGroups(groupsRaw: unknown[]): CpModelQuota[] {
  const models: CpModelQuota[] = [];
  for (const [index, gRaw] of groupsRaw.entries()) {
    const g = asRecord(gRaw);
    if (!g) continue;
    const name = str(g.displayName ?? g.display_name) ?? `Quota Group ${index + 1}`;
    const tightest = tightestBucket(g.buckets);
    if (tightest) {
      models.push({
        name,
        used: tightest.used,
        ...("resetAt" in tightest && { resetAt: tightest.resetAt }),
      });
    }
  }
  return models.sort((a, b) => b.used - a.used);
}

/** Legacy flat shape: one row per model entry. */
function rowsFromModels(modelsRaw: unknown[]): CpModelQuota[] {
  const models: CpModelQuota[] = [];
  for (const mRaw of modelsRaw) {
    const m = asRecord(mRaw);
    if (!m) continue;
    const name = str(m.name ?? m.model ?? m.model_id ?? m.modelId);
    if (!name) continue;
    const tightest = tightestBucket(m.buckets);
    if (tightest) {
      models.push({
        name,
        used: tightest.used,
        ...("resetAt" in tightest && { resetAt: tightest.resetAt }),
      });
    }
  }
  // Tightest models first — the constraint the user hits next leads the card.
  return models.sort((a, b) => b.used - a.used);
}

/** Convenience: the relay envelope's upstream status (200 unless malformed). */
export function relayUpstreamStatus(text: string): number {
  try {
    const doc = asRecord(JSON.parse(text));
    return num(doc?.status_code ?? doc?.statusCode) ?? 200;
  } catch {
    return 200;
  }
}

/** Convenience: the relay envelope's upstream body (a STRING inside). */
export function relayUpstreamBody(text: string): string | undefined {
  try {
    const doc = asRecord(JSON.parse(text));
    return str(doc?.body);
  } catch {
    return undefined;
  }
}

export type { CpAccountQuota, CpModelQuota };
