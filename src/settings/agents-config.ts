/**
 * Sub-agent configuration: the agent definitions plus the state file.
 *
 * Two stores, two different jobs:
 *
 *  - `~/.zcode/agents/<name>.md` — the agent itself: YAML frontmatter plus a
 *    system-prompt body.
 *  - `~/.zcode/v2/agents-state.json` — enablement and model overrides. Built-in
 *    agents have no file at all, so their model override can ONLY live here.
 *
 * Scope: everything the desktop app's own agent form edits — `name`,
 * `description`, `color`, `model`, `thoughtLevel`, the system-prompt BODY, and
 * the advanced frontmatter the runtime reads (`tools`, `disallowedTools`,
 * `skills`, `permissionMode`, `maxTurns`, `background`, `injectAgentsMd`) —
 * plus create / delete / enable.
 *
 * The advanced fields used to be out of scope, on the argument that a JSON
 * round-trip risks whitespace and escaping damage. That risk is real but it is
 * handled where it belongs: `updateAgent` re-parses what it just serialized and
 * refuses the write when anything differs, so a field this module understands
 * cannot be silently mangled. Fields it does NOT understand still ride through
 * verbatim as unknown frontmatter keys.
 *
 * Consequences which callers must know:
 *
 *  - Editing an agent REWRITES its frontmatter from the parsed model, so an
 *    unknown key is re-emitted in canonical position while its value survives.
 *  - A `null` in a patch clears that key (the app's "inherit" choice); an
 *    omitted key is left alone.
 */

import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { readJsonDocument, writeJsonAtomic, writeTextAtomic } from "./atomic-write.js";
import { zcodeAgentsDir, zcodeAgentsStatePath, zcodeHomeDir } from "../utils.js";

/** The eight colors the app's picker offers. */
export const AGENT_COLORS = [
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
] as const;

export type AgentColor = (typeof AGENT_COLORS)[number];

/** Agents the app ships and forbids editing. */
export const BUILT_IN_AGENTS = ["general-purpose", "Explore"] as const;

/**
 * A user-scope agent id is `user:<lowercased name>` — the spelling the state
 * file's `disabledAgentIds` uses.
 */
export function agentStateId(name: string): string {
  return `user:${name.toLowerCase()}`;
}

/** File name for an agent: lowercased name + `.md`. */
export function agentFileName(name: string): string {
  return `${name.toLowerCase()}.md`;
}

/** `^[a-zA-Z0-9-]+$`, 3–50 chars — the app's own name rule. */
const NAME_PATTERN = /^[a-zA-Z0-9-]+$/;

export function isValidAgentName(name: string): boolean {
  return name.length >= 3 && name.length <= 50 && NAME_PATTERN.test(name);
}

export interface AgentModelSelection {
  providerId: string;
  modelId: string;
  thoughtLevel?: string;
}

/** The advanced frontmatter a client may write. */
export interface AgentAdvancedFields {
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  permissionMode?: string;
  maxTurns?: number;
  background?: boolean;
  injectAgentsMd?: boolean;
}

/** The frontmatter fields this module reads and writes. */
export interface AgentFrontmatter {
  name: string;
  description: string;
  color?: string;
  model?: string;
  thoughtLevel?: string;
  tools?: string[];
  disallowedTools?: string[];
  skills?: string[];
  permissionMode?: string;
  maxTurns?: number;
  background?: boolean;
  injectAgentsMd?: boolean;
  /** Everything else in the file, preserved verbatim on rewrite. */
  [key: string]: unknown;
}

/** The permission modes the runtime accepts (subagent-profile.ts). */
export const AGENT_PERMISSION_MODES = [
  "acceptEdits",
  "auto",
  "bypassPermissions",
  "default",
  "dontAsk",
  "plan",
] as const;

export interface AgentEntry {
  /** Lowercased name — the stable identity. */
  name: string;
  fileName: string;
  path: string;
  frontmatter: AgentFrontmatter;
  /** Body text, exposed read-only so a client can show it. */
  systemPrompt: string;
  /** From the state file: disabled agents are excluded from the runtime. */
  enabled: boolean;
  /** Built-in agents cannot be edited or deleted. */
  readOnly: boolean;
  /** Resolved model override, when one is set. */
  modelSelection?: AgentModelSelection;
}

export interface AgentsStateFile {
  builtInModelSelectionOverrides?: Record<string, AgentModelSelection>;
  pluginAgentModelSelectionOverrides?: Record<string, AgentModelSelection>;
  disabledAgentIds?: string[];
  [key: string]: unknown;
}

// ---------- state file ----------

/** Read the state file; absent → an empty document. */
export async function readAgentsState(): Promise<AgentsStateFile> {
  const doc = await readJsonDocument(zcodeAgentsStatePath());
  return (doc ?? {}) as AgentsStateFile;
}

function validateAgentsState(doc: Record<string, unknown>): boolean | string {
  const disabled = doc["disabledAgentIds"];
  if (disabled !== undefined && !Array.isArray(disabled)) {
    return "disabledAgentIds must be an array";
  }
  for (const key of ["builtInModelSelectionOverrides", "pluginAgentModelSelectionOverrides"]) {
    const value = doc[key];
    if (
      value !== undefined &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      return `${key} must be an object`;
    }
  }
  return true;
}

async function saveAgentsState(
  mutator: (doc: AgentsStateFile) => AgentsStateFile,
): Promise<AgentsStateFile> {
  const { doc } = await writeJsonAtomic(
    zcodeAgentsStatePath(),
    (current) => mutator(current as AgentsStateFile) as Record<string, unknown>,
    { validate: (d) => validateAgentsState(d) },
  );
  return doc as AgentsStateFile;
}

/**
 * Enable or disable a user-scope agent.
 *
 * Only `user:` agents can be disabled — built-ins have no disable record (the
 * app's `attachEnabledState` ignores any other scope), and a plugin agent's
 * enablement belongs to its plugin.
 */
export async function setAgentEnabled(name: string, enabled: boolean): Promise<AgentsStateFile> {
  const key = agentStateId(name);
  if (BUILT_IN_AGENTS.includes(name as (typeof BUILT_IN_AGENTS)[number])) {
    throw new Error(`${name} is a built-in agent and cannot be disabled`);
  }
  return saveAgentsState((doc) => {
    const current = Array.isArray(doc.disabledAgentIds) ? [...doc.disabledAgentIds] : [];
    const next = enabled ? current.filter((id) => id !== key) : [...new Set([...current, key])];
    if (next.length === 0) {
      const { disabledAgentIds: _dropped, ...rest } = doc;
      return rest as AgentsStateFile;
    }
    return { ...doc, disabledAgentIds: next };
  });
}

/**
 * Set a built-in agent's model override.
 *
 * This is the ONLY way a built-in agent's model can change: it has no markdown
 * file, so the override lives in the state file. `undefined` clears it, which
 * restores inheritance from the workspace default.
 */
export async function setBuiltInAgentModel(
  name: string,
  selection: AgentModelSelection | undefined,
): Promise<AgentsStateFile> {
  if (!BUILT_IN_AGENTS.includes(name as (typeof BUILT_IN_AGENTS)[number])) {
    throw new Error(`${name} is not a built-in agent`);
  }
  if (selection !== undefined) {
    if (!selection.providerId || !selection.modelId) {
      throw new Error("a model override needs both providerId and modelId");
    }
  }
  return saveAgentsState((doc) => {
    const current = { ...(doc.builtInModelSelectionOverrides ?? {}) };
    if (selection === undefined) delete current[name];
    else current[name] = selection;
    const next: AgentsStateFile = { ...doc };
    if (Object.keys(current).length === 0) delete next.builtInModelSelectionOverrides;
    else next.builtInModelSelectionOverrides = current;
    return next;
  });
}

// ---------- agent markdown ----------

/**
 * Split a markdown file into its frontmatter block and body.
 *
 * Exported for the round-trip tests, which are the only place the parser and
 * the serializer are exercised as a pair.
 */
export function splitFrontmatter(content: string): { frontmatter: string; body: string } | null {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end < 0) return null;
  return { frontmatter: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

/**
 * Parse frontmatter with the same loose semantics the runtime uses.
 *
 * YAML first, then line-level key/value with bracket-list support. The runtime * deliberately accepts non-strict frontmatter so a hand-written file still
 * loads; reading with the same rules keeps a file the CLI accepted visible here
 * instead of silently missing from the list.
 */
export function parseFrontmatter(block: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const lines = block.split(/\r?\n/u);
  let pendingListKey: string | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const listMatch = line.match(/^\s*-\s+(.*)$/u);
    if (listMatch && pendingListKey) {
      const existing = Array.isArray(values[pendingListKey])
        ? (values[pendingListKey] as unknown[])
        : [];
      values[pendingListKey] = [...existing, unquote(listMatch[1]!.trim())];
      continue;
    }
    pendingListKey = undefined;
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/u);
    if (!kv) continue;
    const key = kv[1]!;
    const raw = kv[2] ?? "";
    if (raw.trim() === "") {
      values[key] = [];
      pendingListKey = key;
      continue;
    }
    values[key] = parseScalar(raw.trim());
  }
  return values;
}

function parseScalar(raw: string): unknown {
  const value = stripComment(raw);
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^\d+$/u.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    return value
      .slice(1, -1)
      .split(",")
      .map((s) => unquote(s.trim()))
      .filter((s) => s !== "");
  }
  return unquote(value);
}

function stripComment(value: string): string {
  let quote: string | undefined;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!;
    if ((char === '"' || char === "'") && value[i - 1] !== "\\") {
      quote = quote === char ? undefined : (quote ?? char);
    }
    if (!quote && char === "#" && /\s/u.test(value[i - 1] ?? "")) {
      return value.slice(0, i).trimEnd();
    }
  }
  return value;
}

/**
 * Strip surrounding quotes and undo the escapes the writer emits.
 *
 * `\n` → newline is required for round-tripping: a multi-line description is
 * stored as an escaped scalar, and without this the value would come back as
 * the two characters `\` and `n` instead of a line break — which then fails the
 * writer's own round-trip check and blocks every edit.
 */
function unquote(value: string): string {
  let out = value;
  if (out.length >= 2) {
    const first = out[0]!;
    if ((first === '"' || first === "'") && out.endsWith(first)) out = out.slice(1, -1);
  }
  if (!value.startsWith('"')) return out; // escapes only apply in double quotes
  return out.replace(/\\n/gu, "\n").replace(/\\"/gu, '"').replace(/\\\\/gu, "\\");
}

function escapeYaml(value: string): string {
  // Backslash first, then the quote, then real newlines: the reader turns a
  // literal `\n` sequence back into a newline, so a multi-line description must
  // be stored escaped or the YAML block would break apart.
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/\r\n/gu, "\\n")
    .replace(/\n/gu, "\\n")
    .replace(/\r/gu, "\\n");
}

/**
 * Serialize an agent file.
 *
 * Mirrors the app's writer: `name` and `description` are always quoted, scalars
 * are emitted only when set, lists as YAML block sequences, and the body
 * follows the closing `---`. Unknown frontmatter keys are re-emitted after the
 * known ones so a hand-added field survives an edit.
 */
export function serializeAgentMarkdown(frontmatter: AgentFrontmatter, body: string): string {
  const lines: string[] = [
    `name: "${escapeYaml(frontmatter.name)}"`,
    `description: "${escapeYaml(frontmatter.description)}"`,
  ];
  // Every key emitted explicitly above. Anything NOT in this set is an unknown
  // field that rides along verbatim — leaving a known key out here would emit
  // it twice.
  const known = new Set([
    "name",
    "description",
    "color",
    "model",
    "thoughtLevel",
    "tools",
    "disallowedTools",
    "skills",
    "permissionMode",
    "maxTurns",
    "background",
    "injectAgentsMd",
  ]);
  const scalar = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (typeof value === "string") lines.push(`${key}: "${escapeYaml(value)}"`);
    else if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${value}`);
    }
  };
  scalar("color", frontmatter.color);
  scalar("model", frontmatter.model);
  scalar("thoughtLevel", frontmatter.thoughtLevel);
  const list = (key: string, value: unknown): void => {
    if (!Array.isArray(value) || value.length === 0) return;
    lines.push(`${key}:`);
    for (const item of value) lines.push(`  - ${typeof item === "string" ? item : String(item)}`);
  };
  list("tools", frontmatter.tools);
  list("disallowedTools", frontmatter.disallowedTools);
  list("skills", frontmatter.skills);
  scalar("permissionMode", frontmatter.permissionMode);
  if (typeof frontmatter.maxTurns === "number") lines.push(`maxTurns: ${frontmatter.maxTurns}`);
  if (typeof frontmatter.background === "boolean") {
    lines.push(`background: ${frontmatter.background ? "true" : "false"}`);
  }
  if (typeof frontmatter.injectAgentsMd === "boolean") {
    lines.push(`injectAgentsMd: ${frontmatter.injectAgentsMd ? "true" : "false"}`);
  }
  // Unknown keys ride along verbatim — a field a newer app added must survive
  // an edit made through this bridge.
  for (const [key, value] of Object.entries(frontmatter)) {
    if (known.has(key)) continue;
    if (Array.isArray(value)) list(key, value);
    else scalar(key, value);
  }
  const trimmed = body.trim();
  return `---\n${lines.join("\n")}\n---\n${trimmed ? `${trimmed}\n` : ""}`;
}

/** The minimal body a newly created agent starts with. */
const TEMPLATE_BODY = "You are a helpful assistant.\n";

/**
 * Replace an agent file's bytes.
 *
 * Atomic + backed up: the round-trip check above has already proven the content
 * parses, so the only remaining failure mode is a crash mid-write, and that must
 * leave either the old file or the new one.
 */
async function writeAgentFile(filePath: string, content: string): Promise<void> {
  await writeTextAtomic(filePath, content);
}

async function listAgentFiles(): Promise<string[]> {
  const dir = zcodeAgentsDir();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".md") && !entry.endsWith(".markdown")) continue;
    try {
      if ((await stat(path.join(dir, entry))).isFile()) out.push(entry);
    } catch {
      /* vanished mid-scan */
    }
  }
  return out.sort();
}

/**
 * Every agent: the built-ins, then the user-scope markdown files, each with its
 * enablement and model override resolved from the state file.
 */
export async function listAgents(): Promise<AgentEntry[]> {
  const state = await readAgentsState();
  const disabled = new Set(state.disabledAgentIds ?? []);
  const overrides = state.builtInModelSelectionOverrides ?? {};
  const out: AgentEntry[] = BUILT_IN_AGENTS.map((name) => ({
    name,
    fileName: "",
    path: "",
    frontmatter: { name, description: "" },
    systemPrompt: "",
    enabled: true,
    readOnly: true,
    ...(overrides[name] ? { modelSelection: overrides[name] } : {}),
  }));
  const dir = zcodeAgentsDir();
  for (const fileName of await listAgentFiles()) {
    const filePath = path.join(dir, fileName);
    let content: string;
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      continue;
    }
    const split = splitFrontmatter(content);
    if (!split) continue; // no frontmatter — the runtime ignores it too
    const fm = parseFrontmatter(split.frontmatter);
    const name = typeof fm.name === "string" ? fm.name : "";
    if (!name) continue;
    const id = agentStateId(name);
    out.push({
      name,
      fileName,
      path: filePath,
      frontmatter: {
        ...fm,
        name,
        description: typeof fm.description === "string" ? fm.description : "",
      },
      systemPrompt: split.body.trim(),
      enabled: !disabled.has(id),
      readOnly: false,
    });
  }
  return out;
}

/** Resolve an agent file path, refusing anything that escapes the directory. */
function resolveAgentFile(name: string): string {
  if (!isValidAgentName(name)) {
    throw new Error(
      `invalid agent name '${name}' — 3-50 characters of letters, digits and hyphens`,
    );
  }
  const dir = zcodeAgentsDir();
  const filePath = path.join(dir, agentFileName(name));
  // Defense in depth: the name pattern already excludes separators, but a
  // symlinked agents dir must not let a write land outside it.
  const resolvedDir = path.resolve(dir);
  const resolved = path.resolve(filePath);
  if (path.dirname(resolved) !== resolvedDir) {
    throw new Error(`agent path escapes the agents directory: ${name}`);
  }
  return filePath;
}

/** A list-of-strings patch: absent = leave alone, null = clear. */
function applyStringList(
  fm: Record<string, unknown>,
  key: "tools" | "disallowedTools" | "skills",
  value: string[] | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null || value.length === 0) delete fm[key];
  else fm[key] = [...value];
}

/** Validate the advanced fields a client sent, before anything is written. */
function validateAdvanced(fields: AgentAdvancedFields): void {
  for (const key of ["tools", "disallowedTools", "skills"] as const) {
    const value = fields[key];
    if (value === undefined) continue;
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      throw new Error(`${key} must be an array of strings`);
    }
  }
  if (fields.permissionMode !== undefined) {
    if (!AGENT_PERMISSION_MODES.includes(fields.permissionMode as never)) {
      throw new Error(`permissionMode must be one of ${AGENT_PERMISSION_MODES.join(", ")}`);
    }
  }
  if (fields.maxTurns !== undefined) {
    if (!Number.isInteger(fields.maxTurns) || fields.maxTurns <= 0) {
      throw new Error("maxTurns must be a positive integer");
    }
  }
}

/** Apply the advanced fields onto a frontmatter object. */
function applyAdvanced(fm: AgentFrontmatter, fields: AgentAdvancedFields): void {
  applyStringList(fm, "tools", fields.tools);
  applyStringList(fm, "disallowedTools", fields.disallowedTools);
  applyStringList(fm, "skills", fields.skills);
  if (fields.permissionMode !== undefined) fm.permissionMode = fields.permissionMode;
  if (fields.maxTurns !== undefined) fm.maxTurns = fields.maxTurns;
  if (fields.background !== undefined) fm.background = fields.background;
  if (fields.injectAgentsMd !== undefined) fm.injectAgentsMd = fields.injectAgentsMd;
}

/**
 * Create an agent file.
 *
 * Refuses to overwrite (the app's own create uses the `wx` flag for the same
 * reason). A caller that supplies a system prompt gets exactly that text as the
 * body; otherwise a minimal template seeds it so the agent is immediately
 * usable.
 */
export async function createAgent(
  input: {
    name: string;
    description: string;
    color?: string;
    model?: string;
    thoughtLevel?: string;
    systemPrompt?: string;
  } & AgentAdvancedFields,
): Promise<AgentEntry> {
  const filePath = resolveAgentFile(input.name);
  if (input.description.trim() === "") {
    throw new Error("description is required");
  }
  if (input.color !== undefined && !AGENT_COLORS.includes(input.color as AgentColor)) {
    throw new Error(`color must be one of ${AGENT_COLORS.join(", ")}`);
  }
  validateAdvanced(input);
  await mkdir(path.dirname(filePath), { recursive: true });
  const frontmatter: AgentFrontmatter = {
    name: input.name,
    description: input.description,
  };
  if (input.color !== undefined) frontmatter.color = input.color;
  if (input.model !== undefined) frontmatter.model = input.model;
  if (input.thoughtLevel !== undefined) frontmatter.thoughtLevel = input.thoughtLevel;
  applyAdvanced(frontmatter, input);
  const body = input.systemPrompt?.trim() ? `${input.systemPrompt.trim()}\n` : TEMPLATE_BODY;
  const content = serializeAgentMarkdown(frontmatter, body);
  // Prove the bytes parse back before creating anything: a create is the one
  // write with no previous file to fall back to.
  assertRoundTrip(frontmatter, content);
  try {
    // Exclusive create: an existing agent must be edited, not replaced.
    await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EEXIST") {
      throw new Error(`agent '${input.name}' already exists`);
    }
    throw error;
  }
  return {
    name: input.name,
    fileName: agentFileName(input.name),
    path: filePath,
    frontmatter,
    systemPrompt: body.trim(),
    enabled: true,
    readOnly: false,
  };
}

/**
 * Update an agent's editable fields.
 *
 * Only the fields present in `patch` change; every other frontmatter key is
 * carried through from the file. `model`/`thoughtLevel` and the string lists
 * accept `null` to CLEAR the key (the app's "inherit" choice). Renaming is a
 * delete + create, which is why it is NOT offered here — a rename would orphan
 * the state file's disable record.
 */
export async function updateAgent(
  name: string,
  patch: {
    description?: string;
    color?: string;
    model?: string | null;
    thoughtLevel?: string | null;
    /** `null` on a list clears it; a string sets the whole prompt body. */
    systemPrompt?: string | null;
    tools?: string[] | null;
    disallowedTools?: string[] | null;
    skills?: string[] | null;
    permissionMode?: string | null;
    maxTurns?: number | null;
    background?: boolean | null;
    injectAgentsMd?: boolean | null;
  },
): Promise<AgentEntry> {
  const filePath = resolveAgentFile(name);
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`agent '${name}' does not exist`);
    }
    throw error;
  }
  const split = splitFrontmatter(content);
  if (!split) throw new Error(`agent '${name}' has no frontmatter`);
  const fm = parseFrontmatter(split.frontmatter);
  if (patch.description !== undefined) {
    if (patch.description.trim() === "") throw new Error("description must not be empty");
    fm.description = patch.description;
  }
  if (patch.color !== undefined) {
    if (!AGENT_COLORS.includes(patch.color as AgentColor)) {
      throw new Error(`color must be one of ${AGENT_COLORS.join(", ")}`);
    }
    fm.color = patch.color;
  }
  // An explicit null clears the key (the app's "inherit" choice).
  const applyScalar = (key: string, value: string | null | undefined): void => {
    if (value === undefined) return;
    if (value === null || value === "") delete fm[key];
    else fm[key] = value;
  };
  applyScalar("model", patch.model);
  applyScalar("thoughtLevel", patch.thoughtLevel);
  applyScalar("permissionMode", patch.permissionMode);
  if (patch.maxTurns !== undefined) {
    if (patch.maxTurns === null) delete fm.maxTurns;
    else {
      if (!Number.isInteger(patch.maxTurns) || patch.maxTurns <= 0) {
        throw new Error("maxTurns must be a positive integer");
      }
      fm.maxTurns = patch.maxTurns;
    }
  }
  for (const key of ["background", "injectAgentsMd"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete fm[key];
    else fm[key] = value;
  }
  for (const key of ["tools", "disallowedTools", "skills"] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value !== null && (!Array.isArray(value) || value.some((v) => typeof v !== "string"))) {
      throw new Error(`${key} must be an array of strings`);
    }
    applyStringList(fm, key, value);
  }
  if (patch.permissionMode !== undefined && patch.permissionMode !== null) {
    if (!AGENT_PERMISSION_MODES.includes(patch.permissionMode as never)) {
      throw new Error(`permissionMode must be one of ${AGENT_PERMISSION_MODES.join(", ")}`);
    }
  }
  const next: AgentFrontmatter = {
    ...fm,
    name: typeof fm.name === "string" ? fm.name : name,
    description: typeof fm.description === "string" ? fm.description : "",
  };
  // The body: an explicit string replaces it, `null` clears it, absent keeps it.
  const body =
    patch.systemPrompt === undefined
      ? split.body
      : patch.systemPrompt === null
        ? ""
        : patch.systemPrompt;
  const written = serializeAgentMarkdown(next, body);
  assertRoundTrip(next, written);
  await writeAgentFile(filePath, written);
  return {
    name: next.name,
    fileName: agentFileName(name),
    path: filePath,
    frontmatter: next,
    systemPrompt: body.trim(),
    enabled: true,
    readOnly: false,
  };
}

/**
 * Prove that `serialized` parses back to `expected`.
 *
 * An escaping mistake would silently rewrite the user's agent, so every known
 * key — not just the editable ones — is compared, and the string lists are
 * compared element by element. Unknown keys are covered too: they are the most
 * likely place for a serializer bug to hide.
 */
function assertRoundTrip(expected: AgentFrontmatter, serialized: string): void {
  const reparsed = splitFrontmatter(serialized);
  if (!reparsed) throw new Error("serialized agent has no frontmatter");
  const back = parseFrontmatter(reparsed.frontmatter);
  for (const [key, before] of Object.entries(expected)) {
    if (before === undefined) continue;
    if (Array.isArray(before)) {
      const after = back[key];
      const left = before.join("\u0000");
      const right = Array.isArray(after) ? after.join("\u0000") : "";
      if (left !== right) {
        throw new Error(`frontmatter round-trip failed for '${key}' — not writing`);
      }
      continue;
    }
    if (typeof before === "object") continue;
    if (String(before) !== String(back[key] ?? "")) {
      throw new Error(`frontmatter round-trip failed for '${key}' — not writing`);
    }
  }
}

/** Delete a user-scope agent file. */
export async function deleteAgent(name: string): Promise<void> {
  const filePath = resolveAgentFile(name);
  try {
    await rm(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      throw new Error(`agent '${name}' does not exist`);
    }
    throw error;
  }
  // A deleted agent must not leave a disable record behind: re-creating it with
  // the same name would otherwise come back disabled.
  await saveAgentsState((doc) => {
    const current = Array.isArray(doc.disabledAgentIds) ? doc.disabledAgentIds : [];
    const next = current.filter((id) => id !== agentStateId(name));
    if (next.length === current.length) return doc;
    if (next.length === 0) {
      const { disabledAgentIds: _dropped, ...rest } = doc;
      return rest as AgentsStateFile;
    }
    return { ...doc, disabledAgentIds: next };
  });
}

/** The ZCode data root, for tests and diagnostics. */
export function agentsRoot(): string {
  return zcodeHomeDir();
}
