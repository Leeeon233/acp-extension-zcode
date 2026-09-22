/**
 * resolveZcodeCommand argv tests.
 *
 * Regression cover for the Happy Eyeballs flag: #182 disabled Node's
 * `autoSelectFamily` to stop the 250ms connect budget from killing slow IPv4
 * edges, but that also drops the dual-stack fallback. A provider configured as
 * `http://localhost:PORT` where localhost resolves `::1` first and the server
 * listens on IPv4 only then fails hard instead of falling through — every
 * prompt hung. The fix pairs the disable with `--dns-result-order=ipv4first`.
 *
 * These lock the flag pair (and the escape hatch) without spawning the real
 * zcode app-server: ZCODE_BIN points at a nonexistent .cjs (the resolver only
 * needs the extension) and ZCODE_NODE at the running test runner, which is
 * sqlite-capable.
 */

import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { builtinProviderEnv, resolveZcodeCommand } from "../src/backend/resolve.js";

const SAVED = {
  ZCODE_BIN: process.env.ZCODE_BIN,
  ZCODE_NODE: process.env.ZCODE_NODE,
  ZCODE_KEEP_HAPPY_EYEBALLS: process.env.ZCODE_KEEP_HAPPY_EYEBALLS,
  ZCODE_DISALLOWED_TOOLS: process.env.ZCODE_DISALLOWED_TOOLS,
};

afterEach(() => {
  for (const [k, v] of Object.entries(SAVED)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function jsLaunchArgs(): string[] {
  process.env.ZCODE_BIN = "/nonexistent/zcode.cjs";
  process.env.ZCODE_NODE = process.execPath;
  delete process.env.ZCODE_DISALLOWED_TOOLS;
  return resolveZcodeCommand();
}

/** Non-JS ZCODE_BIN → the resolver returns the bin plus the backend args. */
function nativeLaunchArgs(): string[] {
  process.env.ZCODE_BIN = "/usr/bin/zcode";
  return resolveZcodeCommand();
}

describe("resolveZcodeCommand Happy Eyeballs args", () => {
  it("disables autoSelectFamily AND pins dns order to ipv4first by default", () => {
    delete process.env.ZCODE_KEEP_HAPPY_EYEBALLS;
    const argv = jsLaunchArgs();
    expect(argv).toContain("--no-network-family-autoselection");
    // Without this the single-address lookup picks ::1 first and a
    // localhost-IPv4-only provider is unreachable.
    expect(argv).toContain("--dns-result-order=ipv4first");
    // Flags must precede the script path or node treats them as script args.
    expect(argv.indexOf("--no-network-family-autoselection")).toBeLessThan(
      argv.indexOf("/nonexistent/zcode.cjs"),
    );
    expect(argv.indexOf("--dns-result-order=ipv4first")).toBeLessThan(
      argv.indexOf("/nonexistent/zcode.cjs"),
    );
    expect(argv.slice(-2)).toEqual(["app-server", "--stdio"]);
  });

  it("drops both flags when ZCODE_KEEP_HAPPY_EYEBALLS is set", () => {
    process.env.ZCODE_KEEP_HAPPY_EYEBALLS = "1";
    const argv = jsLaunchArgs();
    expect(argv).not.toContain("--no-network-family-autoselection");
    expect(argv).not.toContain("--dns-result-order=ipv4first");
  });
});

describe("resolveZcodeCommand disallowed tools", () => {
  it("passes no --disallowed-tools when the env var is unset", () => {
    delete process.env.ZCODE_DISALLOWED_TOOLS;
    expect(nativeLaunchArgs()).toEqual(["/usr/bin/zcode", "app-server", "--stdio"]);
  });

  it("passes ZCODE_DISALLOWED_TOOLS through verbatim as one argument", () => {
    process.env.ZCODE_DISALLOWED_TOOLS = "Bash,Write";
    expect(nativeLaunchArgs()).toEqual([
      "/usr/bin/zcode",
      "app-server",
      "--stdio",
      "--disallowed-tools",
      "Bash,Write",
    ]);
  });

  it("appends the flag after the script path on the JS launch path too", () => {
    process.env.ZCODE_BIN = "/nonexistent/zcode.cjs";
    process.env.ZCODE_NODE = process.execPath;
    process.env.ZCODE_DISALLOWED_TOOLS = "Bash Write";
    const argv = resolveZcodeCommand();
    expect(argv.slice(-4)).toEqual(["app-server", "--stdio", "--disallowed-tools", "Bash Write"]);
    expect(argv.indexOf("/nonexistent/zcode.cjs")).toBeLessThan(argv.indexOf("app-server"));
  });
});

const tempRoots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function providerFixture(layout: "desktop" | "npm" = "desktop") {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "zcode-provider-test-")));
  tempRoots.push(root);
  const entry = path.join(root, "Resources", "glm", "zcode.cjs");
  const builtin =
    layout === "desktop"
      ? path.join(root, "Resources", "config", "provider", "zcode-builtin.json")
      : path.join(path.dirname(entry), "provider", "zcode-builtin.json");
  const personal = path.join(root, ".zcode", "v2", "provider_config.json");
  for (const file of [entry, builtin, personal]) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "{}");
  }
  const argv = [process.execPath, entry, "app-server", "--stdio"];
  const env = { ZCODE_DATA_BASE_DIR: root };
  return { root, entry, builtin, personal, argv, env };
}

describe("provider startup environment", () => {
  it.each(["desktop", "npm"] as const)("pairs provider paths for %s layout", (layout) => {
    const f = providerFixture(layout);
    expect(builtinProviderEnv(f.argv, f.env)).toEqual({
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: f.builtin,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: f.personal,
    });
  });

  it("follows an extensionless symlink to the CLI entry", () => {
    const f = providerFixture();
    const bin = path.join(f.root, "zcode");
    symlinkSync(f.entry, bin);
    expect(builtinProviderEnv([bin, "app-server", "--stdio"], f.env)).toHaveProperty(
      "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
      f.builtin,
    );
  });

  it("preserves explicit host configuration instead of mixing installations", () => {
    const f = providerFixture();
    const env = {
      ...f.env,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/custom/builtin.json",
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/custom/personal.json",
    };
    expect(builtinProviderEnv(f.argv, env)).toEqual({
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: "/custom/builtin.json",
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: "/custom/personal.json",
    });
  });

  it("leaves personal bootstrap to the CLI when no personal config exists", () => {
    const f = providerFixture();
    rmSync(f.personal);
    expect(builtinProviderEnv(f.argv, f.env)).toEqual({
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: f.builtin,
    });
  });

  it("leaves old layouts and missing binaries unchanged", () => {
    const f = providerFixture();
    rmSync(f.builtin);
    expect(builtinProviderEnv(f.argv, f.env)).toEqual({});
    rmSync(f.entry);
    expect(builtinProviderEnv(f.argv, f.env)).toEqual({});
    expect(builtinProviderEnv([process.execPath, "app-server", "--stdio"], {})).toEqual({});
  });

  it("passes both configs to the backend spawned by the server", async () => {
    const f = providerFixture();
    // Synthetic backend: fail exactly at the missing-provider startup boundary.
    writeFileSync(
      f.entry,
      `
      const fs = require('node:fs');
      const builtin = process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE;
      const personal = process.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE;
      if (!builtin || !personal) process.exit(1);
      fs.readFileSync(builtin); fs.readFileSync(personal);
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const { id } = JSON.parse(line);
        process.stdout.write(JSON.stringify({ id, result: { builtin, personal } }) + '\\n');
      });
    `,
    );
    vi.stubEnv("ZCODE_BIN", f.entry);
    vi.stubEnv("ZCODE_NODE", process.execPath);
    vi.stubEnv("ZCODE_DATA_BASE_DIR", f.root);
    vi.stubEnv("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE", "");
    vi.stubEnv("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE", "");
    vi.stubEnv("ZCODE_ACP_SANDBOX", "0");
    const { ZcodeAcpServer } = await import("../src/server.js");
    const server = new ZcodeAcpServer();
    const backend = server.ensureBackend();
    try {
      const response = await backend.request(1, "probe");
      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({ builtin: f.builtin, personal: f.personal });
    } finally {
      await backend.close();
    }
  });
});
