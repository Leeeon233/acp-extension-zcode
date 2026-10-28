import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, it } from "vitest";

it("releases initially nonflowing stdin so the setup reader child exits without EOF", async () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "zacp-reader-child-"));
  // Runs the compiled reader (`pnpm build` first, as crash-guards.test.ts
  // does). A pipe with a TTY-method stub reproduces fresh stdin's
  // readableFlowing=null state without depending on a platform PTY utility.
  const file = path.join(scratch, "reader.mjs");
  writeFileSync(
    file,
    `import { readHiddenApiKey } from ${JSON.stringify(path.resolve("dist/account-setup.js"))};
process.stdin.isTTY = true;
process.stdin.isRaw = false;
process.stdin.setRawMode = function(value) { this.isRaw = value; return this; };
if (process.stdin.readableFlowing !== null) process.exit(2);
readHiddenApiKey(process.stdin, process.stdout).then(() => process.stdout.write("FINISHED\\n"));
`,
  );
  const child = spawn(process.execPath, [file], { stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (bytes) => {
    output += String(bytes);
  });
  // Deliberately keep the input pipe open after the key. Before the fix this
  // left a flowing stdin handle and the child never exited on its own.
  child.stdin.write("synthetic-child-key\r");
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("Setup reader did not release stdin"));
      }, 3000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });
    expect(code).toBe(0);
    expect(output).toContain("FINISHED");
    expect(output).not.toContain("synthetic-child-key");
  } finally {
    child.kill();
    rmSync(scratch, { recursive: true, force: true });
  }
});
