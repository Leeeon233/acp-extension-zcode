/** Bridge-owned Coding Plan keys. Desktop configuration is never modified. */
import { randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { mkdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { warn, zcodeHomeDir } from "../utils.js";
import { readBuiltinTable } from "./account-provider.js";

export type CodingPlanFamily = "zai" | "bigmodel";
type Accounts = Partial<Record<CodingPlanFamily, { apiKey: string }>>;
interface Provider {
  name?: string;
  kind?: string;
  enabled?: boolean;
  options?: { apiKey?: string; baseURL?: string };
  models?: Record<string, unknown>;
}
export interface CredentialConfig {
  provider?: Record<string, Provider>;
}

export function bridgeAccountsPath(): string {
  return path.join(zcodeHomeDir(), "v2", "acp-accounts.json");
}

function validKey(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 4096 && /^[!-~]+$/u.test(value)
  );
}

function fixOrRemove(file: string): string {
  return `Fix or remove ${file}, then run zcode-acp setup again.`;
}

export function readBridgeAccounts(file = bridgeAccountsPath()): Accounts {
  let fd: number;
  try {
    // lstat also rejects dangling links on platforms without O_NOFOLLOW.
    if (lstatSync(file).isSymbolicLink()) throw new Error("Linked bridge account configuration");
    // Without O_NONBLOCK, opening a FIFO waits for a writer. With it, the
    // isFile() check below rejects the FIFO.
    fd = openSync(
      file,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Cannot read bridge account configuration. ${fixOrRemove(file)}`);
  }
  try {
    const info = fstatSync(fd);
    const link = lstatSync(file);
    if (
      link.isSymbolicLink() ||
      link.ino !== info.ino ||
      link.dev !== info.dev ||
      info.size > 64 * 1024 ||
      !info.isFile() ||
      info.nlink !== 1 ||
      (process.platform !== "win32" &&
        (info.mode & 0o077 ||
          (typeof process.getuid === "function" && info.uid !== process.getuid())))
    )
      throw new Error("Bridge account configuration must be an owner-only regular file");
    const parsed = JSON.parse(readFileSync(fd, "utf8"));
    if (
      parsed?.version !== 1 ||
      !parsed.accounts ||
      typeof parsed.accounts !== "object" ||
      Array.isArray(parsed.accounts)
    )
      throw new Error();
    const out: Accounts = {};
    for (const [family, account] of Object.entries(parsed.accounts)) {
      if (
        (family !== "zai" && family !== "bigmodel") ||
        !validKey((account as { apiKey?: unknown })?.apiKey)
      )
        throw new Error();
      out[family] = { apiKey: (account as { apiKey: string }).apiKey };
    }
    return out;
  } catch {
    throw new Error(`Invalid or insecure bridge account configuration. ${fixOrRemove(file)}`);
  } finally {
    closeSync(fd);
  }
}

export async function saveBridgeAccount(
  family: CodingPlanFamily,
  apiKey: string,
  file = bridgeAccountsPath(),
): Promise<void> {
  if ((family !== "zai" && family !== "bigmodel") || !validKey(apiKey))
    throw new Error("Invalid Coding Plan account");
  try {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  } catch {
    throw new Error("Cannot create private bridge account directory");
  }
  // Exclusive lock makes concurrent read-modify-write fail explicitly rather
  // than silently losing the other family's key. No credential enters its name.
  const lock = `${file}.lock`;
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch {
    throw new Error(
      `Account setup is already running or its lock is unavailable. If no setup is running, remove ${lock} and retry.`,
    );
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const accounts = readBridgeAccounts(file);
    accounts[family] = { apiKey };
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, accounts }) + "\n", {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, file);
    } catch {
      throw new Error("Cannot save bridge account configuration; existing accounts were preserved");
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
    await rmdir(lock).catch(() => undefined);
  }
}

/** Use the installed public catalog rather than inventing plan model IDs. */
export function codingPlanCatalog(family: CodingPlanFamily): {
  models: string[];
  baseURL: string;
  name: string;
} {
  // account-provider.ts imports this module back, so read only at call time.
  const rule = readBuiltinTable()?.table.config?.providerConfigRules?.providerRules?.find(
    (rule) => rule.providerId === `account:${family}-individual-coding-plan`,
  );
  const models: unknown = rule?.config?.builtinModelIds;
  if (
    Array.isArray(models) &&
    models.length &&
    models.every((model) => typeof model === "string" && model.length)
  )
    return {
      models,
      name: family === "zai" ? "Z.ai Coding Plan" : "BigModel Coding Plan",
      baseURL:
        family === "zai"
          ? "https://api.z.ai/api/anthropic"
          : "https://open.bigmodel.cn/api/anthropic",
    };
  throw new Error(
    `The installed ZCode provider table has no ${family} Coding Plan. Install a supported ZCode CLI or set ZCODE_BIN.`,
  );
}

const warned = new Set<string>();
/** Once per message: credential readers run before every model request. */
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  warn(message);
}

/** Saved accounts, or none when the file cannot be trusted. Never takes Desktop credentials down. */
function overlayAccounts(): Accounts {
  try {
    return readBridgeAccounts();
  } catch (error) {
    warnOnce(`bridge-accounts: ignoring saved accounts. ${(error as Error).message}`);
    return {};
  }
}

type Overlay = { apiKey: string; catalog: ReturnType<typeof codingPlanCatalog> };

/**
 * The saved accounts whose family the installed catalog supports. The overlay
 * and the entitlement rung both read this, so a skipped family is neither
 * overlaid nor entitled.
 */
export function bridgeOverlays(): Partial<Record<CodingPlanFamily, Overlay>> {
  const out: Partial<Record<CodingPlanFamily, Overlay>> = {};
  for (const [family, account] of Object.entries(overlayAccounts())) {
    try {
      out[family as CodingPlanFamily] = {
        apiKey: account.apiKey,
        catalog: codingPlanCatalog(family as CodingPlanFamily),
      };
    } catch (error) {
      warnOnce(`bridge-accounts: skipping the ${family} account. ${(error as Error).message}`);
    }
  }
  return out;
}

/** Desktop entries retain their order; explicit bridge keys override only their plan. */
export function readCredentialConfig(legacyFile: string): CredentialConfig {
  const overlays = bridgeOverlays();
  let config: CredentialConfig;
  try {
    config = JSON.parse(readFileSync(legacyFile, "utf8"));
  } catch (error) {
    if (!Object.keys(overlays).length)
      throw new Error("Cannot read Desktop credential configuration");
    // Saved accounts stand on their own, and the entitlement rung already
    // counts them, so an unreadable Desktop file must not leave them unanswered.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      warnOnce("bridge-accounts: ignoring an unreadable Desktop credential configuration.");
    config = {};
  }
  const provider = { ...config.provider };
  for (const [family, { apiKey, catalog }] of Object.entries(overlays)) {
    const id = `builtin:${family}-coding-plan`;
    const desktop = provider[id];
    // The bridge owns the key, endpoint, and enablement. Desktop per-model data
    // (context window, reasoning variants) stays.
    provider[id] = {
      ...desktop,
      name: desktop?.name ?? catalog.name,
      kind: "anthropic",
      enabled: true,
      options: { ...desktop?.options, apiKey, baseURL: catalog.baseURL },
      models: Object.fromEntries(
        catalog.models.map((model) => [model, desktop?.models?.[model] ?? {}]),
      ),
    };
  }
  return { ...config, provider };
}
