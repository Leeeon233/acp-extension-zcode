/**
 * The ZCode encrypted credential store (`~/.zcode/v2/credentials.json`).
 *
 * The desktop app keeps current-account secrets there — OAuth tokens and the
 * per-plan coding-plan API keys (`account-provider:coding-plan:account:<plan>:
 * account:<uid>:api-key`) — AES-256-GCM encrypted, keyed by
 * `ZCODE_CREDENTIAL_SECRET` or a machine-bound fallback string (sha256 of the
 * secret as the key; wire form `enc:v1:<iv>.<authTag>.<ciphertext>`, base64url;
 * plaintext entries pass through unchanged).
 *
 * The cipher primitives are shared with the settings reset-card flow
 * (settings/coding-plan.ts). This module adds the SYNC reader the account
 * snapshot needs — `answerProviderRuntimeHeaders` runs on the frame-arrival
 * path and cannot await — with an mtime+size cache so per-request callers
 * never re-decrypt an unchanged store.
 */

import { createDecipheriv, createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";

import { log, zcodeCredentialsPath } from "../utils.js";

const ENCRYPTED_PREFIX = "enc:v1:";
const CIPHER_ALGORITHM = "aes-256-gcm";

/** Machine-bound fallback secret, mirroring ZCode's credential cipher. */
export function resolveCredentialSecret(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.ZCODE_CREDENTIAL_SECRET?.trim();
  if (configured) return configured;
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {
    /* sandboxed runtimes may not resolve it */
  }
  return `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
}

/**
 * Decrypt one `enc:v1:` credential value.
 *
 * The wire form is `enc:v1:<iv>.<authTag>.<ciphertext>`, all base64url. A value
 * without the prefix is returned as-is (plaintext entries exist in the wild).
 */
export function decryptCredential(value: string, secret: string): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) return value;
  const payload = value.slice(ENCRYPTED_PREFIX.length);
  const parts = payload.split(".");
  if (parts.length !== 3) throw new Error("credential_decrypt_malformed");
  const [ivRaw, tagRaw, cipherRaw] = parts as [string, string, string];
  const iv = Buffer.from(ivRaw, "base64url");
  const authTag = Buffer.from(tagRaw, "base64url");
  const cipherText = Buffer.from(cipherRaw, "base64url");
  const key = createHash("sha256").update(secret).digest();
  try {
    const decipher = createDecipheriv(CIPHER_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(cipherText), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("credentials_unavailable");
  }
}

interface StoreCache {
  file: string;
  secret: string;
  mtimeMs: number;
  size: number;
  entries: Record<string, string>;
}

let storeCache: StoreCache | null = null;

/**
 * Read and decrypt the credential store, synchronously. Returns `{}` when the
 * store is missing or unreadable (a headless-only machine has none). Entries
 * that fail to decrypt are skipped individually — the store also holds OAuth
 * discovery state and other secrets no caller here needs. Cached per
 * mtime+size+secret, so the per-request callers never re-decrypt an unchanged
 * store.
 */
export function readCredentialStoreSync(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const file = zcodeCredentialsPath();
  let mtimeMs: number;
  let size: number;
  try {
    const st = statSync(file);
    mtimeMs = st.mtimeMs;
    size = st.size;
  } catch {
    storeCache = null;
    return {};
  }
  const secret = resolveCredentialSecret(env);
  if (
    storeCache &&
    storeCache.file === file &&
    storeCache.secret === secret &&
    storeCache.mtimeMs === mtimeMs &&
    storeCache.size === size
  ) {
    return storeCache.entries;
  }
  const out: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      try {
        out[key] = decryptCredential(value, secret);
      } catch (error) {
        // One undecryptable entry must not sink the rest (same posture as the
        // settings reader).
        log(
          `credential-store: '${key}' could not be read (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  } catch (e) {
    log(
      `credential-store: unreadable store (${e instanceof Error ? e.message : String(e)}) — treating as empty`,
    );
    return {};
  }
  storeCache = { file, secret, mtimeMs, size, entries: out };
  return out;
}
