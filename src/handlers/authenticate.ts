/**
 * The `authenticate` agent method (#344).
 *
 * initialize advertises one authMethod (`zcode-credentials`), and editors
 * that take the declaration seriously call the method on sign-in — Xcode 27
 * did and the missing handler answered -32601 ("Your request couldn't be
 * completed"); Zed tolerates the gap, which is why this went unnoticed. The
 * bridge cannot drive an interactive login (credentials come from the ZCode
 * desktop app or `zcode-acp setup`, never the editor), so the method is a
 * readiness check: credentials present → `{}` (signed in as far as this
 * agent is concerned); absent → an error whose message says how to get them.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { RequestError } from "@agentclientprotocol/sdk";

import { zcodeCredentialsPresent } from "../config/account-provider.js";
import { messages } from "../i18n.js";

/** The authMethod id initialize advertises (server.ts authMethods). */
export const ZCODE_AUTH_METHOD_ID = "zcode-credentials";

export function authenticate(params: acp.AuthenticateRequest): acp.AuthenticateResponse {
  if (params.methodId !== ZCODE_AUTH_METHOD_ID)
    throw new RequestError(-32602, messages().authErrUnknownMethod(params.methodId));
  if (!zcodeCredentialsPresent()) throw new RequestError(-32000, messages().authErrNoCredentials);
  return {};
}
