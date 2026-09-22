/**
 * Resolve the argv to launch the ZCode app-server subprocess.
 *
 * The ZCode CLI is a Node `.cjs` that relies on a `#!/usr/bin/env node` shebang.
 * Processes launched by GUI launchd (no shell profile) have no `node` on PATH,
 * so the shebang fails. We sidestep it by constructing `[node, zcode.cjs,
 * "app-server", "--stdio"]` with an explicit, sqlite-capable Node binary.
 */

import { existsSync, readdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";

import { log } from "../utils.js";

/** `which bin` — resolve a binary on PATH without external deps. */
function whichSync(bin: string): string | null {
  try {
    const out = execFileSync("which", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Glob the Zed-bundled node directories, newest version first. */
function zedBundledNodes(): string[] {
  const base = path.join(os.homedir(), "Library/Application Support/Zed/node");
  if (!existsSync(base)) return [];
  let entries: string[] = [];
  try {
    entries = readdirSync(base);
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.startsWith("node-v"))
    .sort()
    .reverse()
    .map((d) => path.join(base, d, "bin", "node"));
}

/**
 * Candidate Node binaries in priority order. Deduped, order-preserving.
 * Falls back to the Zed-bundled Node glob as a last resort.
 */
function candidateNodeBinaries(): string[] {
  const cands: string[] = [];
  const envNode = process.env.ZCODE_NODE;
  if (envNode) cands.push(envNode);
  cands.push("/opt/homebrew/bin/node", "/usr/local/bin/node");
  const whichNode = whichSync("node");
  if (whichNode) cands.push(whichNode);
  cands.push(...zedBundledNodes());
  const seen = new Set<string>();
  return cands.filter((c) => {
    if (!c || seen.has(c)) return false;
    seen.add(c);
    return true;
  });
}

/**
 * Verify a Node binary can load `node:sqlite` (ZCode depends on it; Node < 22
 * lacks the module and would crash). Uses `new DatabaseSync(...)` because a
 * bare reference would mis-detect support.
 */
function nodeSupportsSqlite(nodeBin: string): boolean {
  if (!nodeBin || !existsSync(nodeBin)) return false;
  try {
    execFileSync(nodeBin, ["-e", "new (require('node:sqlite').DatabaseSync)(':memory:')"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5000,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Well-known desktop-app bundle locations of the shipped `zcode.cjs`
 * (mirrors the per-platform table in README). The app never adds the CLI to
 * PATH, so a bare terminal launch of the REPL/editor bridge finds it here.
 */
function bundledZcodeCandidates(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [path.join(localAppData, "Programs", "ZCode", "resources", "glm", "zcode.cjs")];
  }
  return [
    "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    path.join(home, "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs"),
    "/opt/ZCode/resources/glm/zcode.cjs",
    "/usr/share/zcode/resources/glm/zcode.cjs",
  ];
}

/**
 * Resolution chain for the zcode CLI when ZCODE_BIN is unset: PATH first
 * (absolute path so the spawn no longer depends on the child's PATH), then
 * the desktop-app bundle locations. `null` when nothing is found — the caller
 * falls back to the bare name and lets spawn surface the failure.
 */
function discoverZcodeBin(): string | null {
  const onPath = whichSync("zcode");
  if (onPath) return onPath;
  for (const c of bundledZcodeCandidates()) {
    if (existsSync(c)) return c;
  }
  return null;
}

/**
 * Happy Eyeballs (`autoSelectFamily`, on by default since Node 20.13) gives
 * each connect attempt a 250ms budget. On a network with no IPv6 route where
 * the provider edge answers in just over 250ms, every undici connect is
 * aborted before it can establish and fetch fails with an empty-message
 * AggregateError — every model request then dies as `Cannot connect to API:`
 * no matter how often it retries, while curl/plain connects to the same host
 * succeed. Disabling it restores the pre-20.13 sequential connect, which
 * works. Set ZCODE_KEEP_HAPPY_EYEBALLS=1 to keep RFC 8305 behavior.
 *
 * Disabling it also removes the dual-stack fallback: `net.connect` then uses a
 * single-address lookup, so a host that resolves `::1` first but only listens
 * on IPv4 fails hard (ECONNREFUSED) instead of falling through — every local
 * provider configured as `http://localhost:PORT` (IPv4-only listeners) dies.
 * `--dns-result-order=ipv4first` restores the pre-17 lookup order so that
 * single address is the IPv4 one; it only reorders, so an IPv6-only host still
 * resolves to IPv6 and IPv4-only edges still connect directly.
 */
function happyEyeballsArgs(): string[] {
  return process.env.ZCODE_KEEP_HAPPY_EYEBALLS
    ? []
    : ["--no-network-family-autoselection", "--dns-result-order=ipv4first"];
}

/**
 * The backend subcommand and its flags, shared by every launch path.
 *
 * `ZCODE_DISALLOWED_TOOLS` is passed verbatim as the app-server's
 * `--disallowed-tools` value; unset means the flag is absent, which is the
 * backend's own default.
 */
export function backendArgs(): string[] {
  const disallowed = process.env.ZCODE_DISALLOWED_TOOLS;
  return ["app-server", "--stdio", ...(disallowed ? ["--disallowed-tools", disallowed] : [])];
}

/** Resolve the full argv to launch `zcode app-server --stdio`. */
export function resolveZcodeCommand(): string[] {
  const zcodeBin = process.env.ZCODE_BIN ?? discoverZcodeBin() ?? "zcode";
  // Non-JS bin (e.g. a `zcode` command or wrapper) → use as-is, rely on its own shebang.
  if (!/\.(cjs|mjs|js)$/.test(zcodeBin)) {
    return [zcodeBin, ...backendArgs()];
  }
  // JS file → launch with an explicit sqlite-capable Node to bypass the shebang.
  for (const nodeBin of candidateNodeBinaries()) {
    if (nodeSupportsSqlite(nodeBin)) {
      let ver = "?";
      try {
        // argv form (no shell, space-safe); capture stderr so it doesn't leak.
        ver = execFileSync(nodeBin, ["--version"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
      } catch {
        // keep "?"
      }
      log(`resolve: launching zcode with node ${nodeBin} (${ver})`);
      return [nodeBin, ...happyEyeballsArgs(), zcodeBin, ...backendArgs()];
    }
  }
  log(
    "resolve: no sqlite-capable node found; falling back to PATH-resolved zcode shebang " +
      "(may fail under GUI launch)",
  );
  return [zcodeBin, ...backendArgs()];
}

/**
 * Desktop bundles keep the provider table outside glm/, unlike npm installs.
 * Resolve against the actual launched entry (including symlinks), before any
 * sandbox wrapping. Explicit host paths stay authoritative. Pair the builtin
 * path with an existing personal config to prevent CLI revision remapping.
 */
export function builtinProviderEnv(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const builtinKey = "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE";
  const personalKey = "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE";
  let builtin = env[builtinKey]?.trim();
  if (!builtin) {
    const entry = argv[argv.indexOf("app-server") - 1];
    if (!entry) return {};
    let realEntry: string;
    try {
      realEntry = realpathSync(entry);
    } catch {
      return {}; // Missing binaries retain the normal spawn error path.
    }
    if (!/\.(cjs|mjs|js)$/.test(realEntry)) return {};
    const dir = path.dirname(realEntry);
    builtin = [
      path.join(dir, "provider", "zcode-builtin.json"),
      path.join(dir, "..", "config", "provider", "zcode-builtin.json"),
    ].find((candidate) => existsSync(candidate));
  }
  if (!builtin) return {};
  const result: NodeJS.ProcessEnv = { [builtinKey]: builtin };
  const personal =
    env[personalKey]?.trim() ||
    path.join(
      env.ZCODE_DATA_BASE_DIR?.trim() || os.homedir(),
      ".zcode",
      "v2",
      "provider_config.json",
    );
  // Do not invent a personal config on a fresh install; let the CLI bootstrap it.
  if (env[personalKey]?.trim() || existsSync(personal)) result[personalKey] = personal;
  return result;
}
