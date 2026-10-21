/**
 * agents-config.ts + skills.ts tests.
 *
 * The agent half is about the two-store split (markdown file vs state file) and
 * the frontmatter round-trip: an escaping mistake would silently rewrite a
 * user's agent, so serialize→parse must be asserted directly. The skills half
 * is about the escape guards — a client-supplied path becomes an `rm -rf`, so
 * traversal and symlink attempts must be refused.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AGENT_COLORS,
  agentStateId,
  createAgent,
  deleteAgent,
  listAgents,
  parseFrontmatter,
  serializeAgentMarkdown,
  setAgentEnabled,
  setBuiltInAgentModel,
  splitFrontmatter,
  updateAgent,
} from "../src/settings/agents-config.js";
import {
  copySkillToUser,
  deleteSkill,
  listSkills,
  setSkillEnabledByPath,
} from "../src/settings/skills.js";
import { zcodeAgentsDir, zcodeHomeDir } from "../src/utils.js";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), "settings-agents-test-"));
  // ZCODE_HOME redirects the ZCode data root; HOME additionally moves the
  // shared `~/.agents` root, which is resolved from homedir() rather than from
  // the ZCode root. Both must point at the temp dir or the tests would read the
  // developer's real skills.
  vi.stubEnv("ZCODE_HOME", home);
  vi.stubEnv("HOME", home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

/** Write a file, creating its directory. */
async function put(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, "utf8");
}

describe("agent name rules", () => {
  it("accepts 3-50 chars of letters, digits and hyphens", async () => {
    await expect(createAgent({ name: "ab", description: "x" })).rejects.toThrow(
      /invalid agent name/,
    );
    await expect(createAgent({ name: "a".repeat(51), description: "x" })).rejects.toThrow(
      /invalid agent name/,
    );
    await expect(createAgent({ name: "has_underscore", description: "x" })).rejects.toThrow(
      /invalid agent name/,
    );
    await expect(createAgent({ name: "../escape", description: "x" })).rejects.toThrow(
      /invalid agent name/,
    );
  });

  it("builds the state id and file name from the lowercased name", () => {
    expect(agentStateId("MyAgent")).toBe("user:myagent");
  });
});

describe("agent markdown serialization", () => {
  it("quotes name and description and puts the body after the closing fence", () => {
    const out = serializeAgentMarkdown(
      { name: "rev", description: 'says "hi"' },
      "You are strict.",
    );
    expect(out).toBe('---\nname: "rev"\ndescription: "says \\"hi\\""\n---\nYou are strict.\n');
  });

  it("emits scalars only when set and lists as block sequences", () => {
    const out = serializeAgentMarkdown(
      { name: "a", description: "b", color: "blue", maxTurns: 25, tools: ["*"], background: false },
      "body",
    );
    // Strings are quoted, because an unquoted scalar carrying a newline or a
    // leading indicator would break the YAML block on the next parse.
    expect(out).toContain('color: "blue"');
    expect(out).toContain("maxTurns: 25");
    expect(out).toContain("background: false");
    expect(out).toContain("tools:\n  - *");
    // No model keys when none were given.
    expect(out).not.toContain("model:");
  });

  it("preserves unknown frontmatter keys across a rewrite", () => {
    const out = serializeAgentMarkdown(
      { name: "a", description: "b", futureField: "kept", futureList: ["x"] },
      "body",
    );
    expect(out).toContain('futureField: "kept"');
    expect(out).toContain("futureList:\n  - x");
  });

  it("escapes an unknown key whose value contains a newline", () => {
    // The parser turns `\n` back into a real newline, so the serializer MUST
    // escape it — emitting it raw would split the YAML block and silently drop
    // the value on the next parse.
    const out = serializeAgentMarkdown(
      { name: "a", description: "b", whenToUse: "morning\nafternoon" },
      "body",
    );
    expect(out).toContain('whenToUse: "morning\\nafternoon"');
    const reparsed = parseFrontmatter(splitFrontmatter(out)!.frontmatter);
    expect(reparsed["whenToUse"]).toBe("morning\nafternoon");
  });

  it("round-trips a description containing quotes, backslashes and newlines", async () => {
    const description = 'line1\nline2 "quoted" back\\slash';
    const created = await createAgent({ name: "tricky", description });
    const updated = await updateAgent("tricky", { description: `${description}!` });
    expect(updated.frontmatter.description).toBe(`${description}!`);
    const raw = await readFile(created.path, "utf8");
    expect(raw).toContain("description:");
    // The escape must be a YAML-legal quoted scalar, not raw control characters.
    expect(raw).not.toContain("\nline2");
  });
});

describe("agent create / update / delete", () => {
  it("creates with a template body and refuses to overwrite", async () => {
    const agent = await createAgent({ name: "reviewer", description: "reviews code" });
    expect(agent.systemPrompt).toBe("You are a helpful assistant.");
    expect(agent.enabled).toBe(true);
    await expect(createAgent({ name: "reviewer", description: "again" })).rejects.toThrow(
      /already exists/,
    );
    // Case-insensitive file name collision must also be refused.
    await expect(createAgent({ name: "Reviewer", description: "again" })).rejects.toThrow();
  });

  it("requires a description and a valid color", async () => {
    await expect(createAgent({ name: "nodesc", description: "  " })).rejects.toThrow(
      /description is required/,
    );
    await expect(
      createAgent({ name: "badcolor", description: "d", color: "teal" }),
    ).rejects.toThrow(/color must be one of/);
    for (const color of AGENT_COLORS) {
      await expect(
        createAgent({ name: `agent-${color}`, description: "d", color }),
      ).resolves.toBeDefined();
    }
  });

  it("updates only the patched fields and keeps the body", async () => {
    await put(
      path.join(zcodeAgentsDir(), "worker.md"),
      '---\nname: "worker"\ndescription: "orig"\ncolor: red\ntools:\n  - "*"\n---\nMy prompt.\n',
    );
    const updated = await updateAgent("worker", { color: "green", model: "builtin:x/GLM-5.3" });
    expect(updated.frontmatter.color).toBe("green");
    expect(updated.frontmatter.model).toBe("builtin:x/GLM-5.3");
    expect(updated.systemPrompt).toBe("My prompt.");
    // The list survives with the same single element; the writer emits block
    // sequences, so `["*"]` comes back as `*` (same value, different spelling).
    expect(updated.frontmatter.tools).toEqual(["*"]);
    const raw = await readFile(path.join(zcodeAgentsDir(), "worker.md"), "utf8");
    expect(raw).toContain("My prompt.");
    expect(raw).toContain("tools:\n  - *");
    // `tools` must be emitted exactly once — a duplicated key makes the file
    // ambiguous for every reader.
    expect(raw.match(/^tools:/gmu)).toHaveLength(1);
  });

  it("clears a model field when given null (the inherit choice)", async () => {
    await put(
      path.join(zcodeAgentsDir(), "inherit.md"),
      '---\nname: "inherit"\ndescription: "d"\nmodel: builtin:x/GLM-5.3\nthoughtLevel: high\n---\nbody\n',
    );
    await updateAgent("inherit", { model: null });
    const raw = await readFile(path.join(zcodeAgentsDir(), "inherit.md"), "utf8");
    expect(raw).not.toContain("model:");
    expect(raw).toContain('thoughtLevel: "high"');
  });

  it("refuses to update or delete an agent that does not exist", async () => {
    await expect(updateAgent("ghost", { color: "red" })).rejects.toThrow(/does not exist/);
    await expect(deleteAgent("ghost")).rejects.toThrow(/does not exist/);
  });

  it("deleting an agent also drops its disable record", async () => {
    await createAgent({ name: "temp", description: "d" });
    await setAgentEnabled("temp", false);
    expect((await readState()).disabledAgentIds).toContain("user:temp");
    await deleteAgent("temp");
    expect((await readState()).disabledAgentIds ?? []).not.toContain("user:temp");
    // Re-creating comes back enabled.
    await createAgent({ name: "temp", description: "d" });
    const entry = (await listAgents()).find((a) => a.name === "temp");
    expect(entry!.enabled).toBe(true);
  });
});

describe("agent enablement and model overrides", () => {
  it("disables, re-enables, and drops the list when empty", async () => {
    await createAgent({ name: "toggle", description: "d" });
    await setAgentEnabled("toggle", false);
    expect((await readState()).disabledAgentIds).toEqual(["user:toggle"]);
    expect((await listAgents()).find((a) => a.name === "toggle")!.enabled).toBe(false);
    await setAgentEnabled("toggle", true);
    expect((await readState()).disabledAgentIds).toBeUndefined();
    expect((await listAgents()).find((a) => a.name === "toggle")!.enabled).toBe(true);
  });

  it("refuses to disable a built-in agent", async () => {
    await expect(setAgentEnabled("general-purpose", false)).rejects.toThrow(/built-in/);
    await expect(setAgentEnabled("Explore", false)).rejects.toThrow(/built-in/);
  });

  it("lists built-ins as read-only with no file", async () => {
    const agents = await listAgents();
    for (const name of ["general-purpose", "Explore"]) {
      const entry = agents.find((a) => a.name === name)!;
      expect(entry.readOnly).toBe(true);
      expect(entry.path).toBe("");
    }
  });

  it("stores and clears a built-in model override", async () => {
    await setBuiltInAgentModel("Explore", {
      providerId: "p",
      modelId: "deepseek-v4-flash",
      options: { reasoningLevel: "high" },
    });
    let entry = (await listAgents()).find((a) => a.name === "Explore")!;
    expect(entry.modelSelection).toEqual({
      providerId: "p",
      modelId: "deepseek-v4-flash",
      options: { reasoningLevel: "high" },
    });
    await setBuiltInAgentModel("Explore", undefined);
    entry = (await listAgents()).find((a) => a.name === "Explore")!;
    expect(entry.modelSelection).toBeUndefined();
    expect((await readState()).builtInModelSelectionOverrides).toBeUndefined();
  });

  it("refuses a model override for a non-built-in agent", async () => {
    await expect(setBuiltInAgentModel("custom", { providerId: "p", modelId: "m" })).rejects.toThrow(
      /not a built-in agent/,
    );
    await expect(setBuiltInAgentModel("Explore", { providerId: "", modelId: "m" })).rejects.toThrow(
      /providerId and modelId/,
    );
  });

  it("skips an agent file with no frontmatter (the runtime ignores it too)", async () => {
    await put(path.join(zcodeAgentsDir(), "plain.md"), "just text\n");
    const agents = await listAgents();
    expect(agents.find((a) => a.name === "plain")).toBeUndefined();
  });
});

// ---------- advanced fields ----------

/**
 * The advanced frontmatter (tools / permissionMode / the prompt body) used to
 * be out of the settings API's scope. These cases pin the contract now that it
 * is in scope: a field the client sends lands in the file, a `null` clears it,
 * and an omitted field is left alone.
 */
describe("agent advanced fields", () => {
  it("creates an agent carrying a real prompt and advanced fields", async () => {
    const agent = await createAgent({
      name: "reviewer",
      description: "Reviews diffs",
      color: "cyan",
      systemPrompt: "You review diffs carefully.",
      tools: ["Read", "Grep"],
      skills: ["pdf"],
      permissionMode: "plan",
      maxTurns: 7,
      injectAgentsMd: false,
    });
    expect(agent.systemPrompt).toBe("You review diffs carefully.");

    const raw = await readFile(path.join(zcodeAgentsDir(), "reviewer.md"), "utf8");
    expect(raw).toContain("You review diffs carefully.");
    expect(raw).toContain('color: "cyan"');
    expect(raw).toContain('permissionMode: "plan"');
    expect(raw).toContain("maxTurns: 7");
    expect(raw).toContain("injectAgentsMd: false");
    expect(raw).toContain("  - Read\n  - Grep");
    expect(raw).toContain("skills:\n  - pdf");

    const listed = (await listAgents()).find((a) => a.name === "reviewer");
    expect(listed?.systemPrompt).toBe("You review diffs carefully.");
    expect(listed?.frontmatter.tools).toEqual(["Read", "Grep"]);
    expect(listed?.frontmatter.permissionMode).toBe("plan");
    expect(listed?.frontmatter.maxTurns).toBe(7);
    expect(listed?.frontmatter.injectAgentsMd).toBe(false);
  });

  it("a null clears a field, an omitted key keeps it", async () => {
    await createAgent({
      name: "keeper",
      description: "d",
      tools: ["Read", "Write"],
      maxTurns: 3,
    });
    await updateAgent("keeper", { tools: null, description: "edited" });
    let raw = await readFile(path.join(zcodeAgentsDir(), "keeper.md"), "utf8");
    expect(raw).not.toContain("tools:");
    // maxTurns was not mentioned, so it must survive the rewrite.
    expect(raw).toContain("maxTurns: 3");

    await updateAgent("keeper", { maxTurns: 9 });
    raw = await readFile(path.join(zcodeAgentsDir(), "keeper.md"), "utf8");
    expect(raw).toContain("maxTurns: 9");
  });

  it("replaces the prompt body and keeps the frontmatter", async () => {
    await createAgent({ name: "prompted", description: "d", color: "red" });
    await updateAgent("prompted", { systemPrompt: "Line one.\nLine two." });
    const listed = (await listAgents()).find((a) => a.name === "prompted");
    expect(listed?.systemPrompt).toBe("Line one.\nLine two.");
    expect(listed?.frontmatter.color).toBe("red");
  });

  it("keeps a hand-written unknown frontmatter key across an edit", async () => {
    await put(
      path.join(zcodeAgentsDir(), "handmade.md"),
      '---\nname: "handmade"\ndescription: "d"\nmcpServers:\n  - search\n---\nBody.\n',
    );
    await updateAgent("handmade", { description: "changed" });
    const raw = await readFile(path.join(zcodeAgentsDir(), "handmade.md"), "utf8");
    expect(raw).toContain("mcpServers:\n  - search");
    expect(raw).toContain('description: "changed"');
  });

  it("refuses fields the runtime would not accept", async () => {
    await expect(
      createAgent({ name: "badmode", description: "d", permissionMode: "nope" }),
    ).rejects.toThrow(/permissionMode must be one of/);
    await expect(createAgent({ name: "badturns", description: "d", maxTurns: 0 })).rejects.toThrow(
      /maxTurns must be a positive integer/,
    );
    await expect(
      createAgent({ name: "badtools", description: "d", tools: [1] as unknown as string[] }),
    ).rejects.toThrow(/must be an array of strings/);
  });

  it("rejects a bad advanced field on update without touching the file", async () => {
    await createAgent({ name: "stable", description: "d" });
    const before = await readFile(path.join(zcodeAgentsDir(), "stable.md"), "utf8");
    await expect(updateAgent("stable", { maxTurns: -1 })).rejects.toThrow(/positive integer/);
    expect(await readFile(path.join(zcodeAgentsDir(), "stable.md"), "utf8")).toBe(before);
  });
});

async function readState(): Promise<Record<string, unknown>> {
  const file = path.join(zcodeHomeDir(), "v2", "agents-state.json");
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ---------- skills ----------

/** Create a skill directory with a SKILL.md. */
async function makeSkill(
  root: string,
  name: string,
  description = `does ${name}`,
): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`,
    "utf8",
  );
  return path.join(dir, "SKILL.md");
}

describe("skills — discovery", () => {
  it("lists skills from the user root with enabled true", async () => {
    const root = path.join(zcodeHomeDir(), "skills");
    await makeSkill(root, "alpha");
    await makeSkill(root, "beta");
    const skills = await listSkills();
    expect(skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(skills.every((s) => s.enabled)).toBe(true);
    expect(skills[0]!.scope).toBe("user");
  });

  it("keeps a disabled skill visible so it can be re-enabled", async () => {
    const root = path.join(zcodeHomeDir(), "skills");
    const file = await makeSkill(root, "gamma");
    await setSkillEnabledByPath(file, false);
    const skills = await listSkills();
    const gamma = skills.find((s) => s.name === "gamma")!;
    expect(gamma.enabled).toBe(false);
    await setSkillEnabledByPath(file, true);
    expect((await listSkills()).find((s) => s.name === "gamma")!.enabled).toBe(true);
  });

  it("skips a directory with no description (the runtime does too)", async () => {
    const root = path.join(zcodeHomeDir(), "skills");
    await mkdir(path.join(root, "silent"), { recursive: true });
    await writeFile(path.join(root, "silent", "SKILL.md"), "---\nname: silent\n---\n", "utf8");
    expect((await listSkills()).find((s) => s.name === "silent")).toBeUndefined();
  });

  it("lists the same name from two scopes separately", async () => {
    await makeSkill(path.join(zcodeHomeDir(), "skills"), "dup");
    await makeSkill(path.join(home, ".agents", "skills"), "dup");
    expect((await listSkills()).filter((s) => s.name === "dup")).toHaveLength(2);
  });
});

describe("skills — guards", () => {
  it("refuses a relative path and a non-SKILL.md target", async () => {
    await expect(setSkillEnabledByPath("skills/a/SKILL.md", false)).rejects.toThrow(
      /must be absolute/,
    );
    await expect(setSkillEnabledByPath("/tmp/whatever.txt", false)).rejects.toThrow(/SKILL\.md/);
  });

  it("refuses to delete a skill outside the user roots", async () => {
    const outside = await makeSkill(path.join(home, "elsewhere"), "rogue");
    await expect(deleteSkill(outside)).rejects.toThrow(/user skill roots/);
    // The directory is still there.
    expect(await readdir(path.join(home, "elsewhere"))).toEqual(["rogue"]);
  });

  it("refuses to delete the skills root itself", async () => {
    const root = path.join(zcodeHomeDir(), "skills");
    await expect(deleteSkill(path.join(root, "SKILL.md"))).rejects.toThrow(/root itself/);
  });

  it("follows a symlink and refuses a delete that would escape", async () => {
    const root = path.join(zcodeHomeDir(), "skills");
    await mkdir(root, { recursive: true });
    // The symlink sits inside the root, so the LEXICAL path looks deletable;
    // its target lives outside every deletable root.
    const victimArea = path.join(home, "victim-area");
    await makeSkill(victimArea, "precious");
    await symlink(path.join(victimArea, "precious"), path.join(root, "linked"));
    await expect(deleteSkill(path.join(root, "linked", "SKILL.md"))).rejects.toThrow(
      /user skill roots/,
    );
    // The target survives: the symlink was refused, not followed.
    expect(await readdir(victimArea)).toEqual(["precious"]);
    expect(await readdir(path.join(victimArea, "precious"))).toEqual(["SKILL.md"]);
  });

  it("deletes a legitimate skill", async () => {
    const root = path.join(zcodeHomeDir(), "skills");
    const file = await makeSkill(root, "doomed");
    await deleteSkill(file);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("skills — copy to user root", () => {
  it("copies and reports the new path", async () => {
    const source = await makeSkill(path.join(home, ".agents", "skills"), "shared");
    const target = await copySkillToUser(source);
    expect(target).toBe(path.join(zcodeHomeDir(), "skills", "shared", "SKILL.md"));
    expect(await readFile(target, "utf8")).toContain("name: shared");
  });

  it("refuses a name collision rather than merging", async () => {
    await makeSkill(path.join(zcodeHomeDir(), "skills"), "clash");
    const source = await makeSkill(path.join(home, ".agents", "skills"), "clash");
    await expect(copySkillToUser(source)).rejects.toThrow(/already exists/);
  });

  it("refuses to copy a skill that is already in the user root", async () => {
    const source = await makeSkill(path.join(zcodeHomeDir(), "skills"), "already");
    await expect(copySkillToUser(source)).rejects.toThrow(/already lives/);
  });
});
