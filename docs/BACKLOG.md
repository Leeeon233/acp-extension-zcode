# Protocol Backlog

Backend RPC methods and event types exposed by the ZCode CLI (`zcode app-server`)
that are **not yet wired into the bridge**, tracked for potential future support.

Last audited against **app-server 0.16.5 bundled in ZCode desktop 3.12.3**
(2026-09-18; the CLI still self-reports "0.16.5" across desktop versions —
the app version, not the CLI string, dates a bundle). Method names were
extracted from the `zcode.cjs` method-name enum (`session/create` → 65
entries) and the v4 enum; event types from the zod event-envelope union.
Live RPC verification of the full model-turn lifecycle was blocked by the
GLM edge's captcha risk-control on headless sessions ("Captcha verification
request timed out", `model_request_failed`) — the v3 background-task channel
(`session.updated` with `taskId`) is confirmed UNCHANGED in 3.12.3: probe
sessions still receive the same event vocabulary, and no `task.*` event types
exist on the v3 stream. `task.upserted` / `task.removed` are **v4 controller
frame ops** (the desktop's conversation-LIST stream — "task" = conversation,
matching `tasks-index.sqlite`'s `tasks` table), `task.output` is a FILE NAME
in the sub-agent output dir, and `backgroundTask.stop` is the TaskStop
tool's permission id — none are v3 events. The previous audit ran against
desktop 3.9.2 / same app-server 0.16.5 (2026-08-27).

## Removed upstream in 0.16 (verified live: `-32601`)

| Method                  | Replacement                                          | Bridge action                                       |
| ----------------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `session/steer`         | v4 command/conversation API                          | Dropped the ACP extension + `/steer` slash command  |
| `session/rewind`        | `v4/conversation/fileRewindPreview` + v4 rewind flow | Dropped the ACP extension + `/rewind` slash command |
| `session/rewindCascade` | v4 rewind flow                                       | Dropped the ACP extension                           |

`session/fork` (branch from checkpoint) is the remaining v3 alternative for
rewind-like UX. The backend still emits `rewind.triggered` /
`checkpoint.created` events, so a client can observe rewinds initiated
elsewhere.

## Candidate methods (optional enhancements)

Available in the backend but with no ACP-side counterpart yet. Pick them up
when a concrete ACP/editor need appears.

| Method                                                                                                                                                                                    | Purpose                                                                                          | Current bridge behavior                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/subagents`                                                                                                                                                                       | Query the list of sub-agents for a session                                                       | Sub-agent info is parsed from the `Agent` tool result (`_meta.subagent`); sufficient for now                                                                                                                                        |
| `session/events`                                                                                                                                                                          | Pull-mode event history (complement to `session/subscribe`)                                      | Not used; could support event replay/gap-fill                                                                                                                                                                                       |
| `session/usage`                                                                                                                                                                           | Per-session token usage                                                                          | Per-turn billing usage is now carried on the ACP `session/prompt` result (`usage` + `_meta.zcode.usage`), sourced from `turn.completed`; this RPC remains a candidate for session-cumulative reconciliation                         |
| `workspace/hooks/trustGrant`                                                                                                                                                              | Server→client request: approve hook trust                                                        | Auto-errored by the unknown-request fallback (`server-requests.ts` `handleOne`) during turns; `session/send` carries a 15s timeout so nothing hangs. If hook trust ever needs real UX, map it onto ACP `session/request_permission` |
| `interaction/browserList` / `interaction/browserExecute`                                                                                                                                  | Server→client requests: browser automation via the client                                        | Auto-errored by the fallback above; only meaningful once an ACP client has a browser surface                                                                                                                                        |
| `interaction/requestProviderRuntimeHeaders`                                                                                                                                               | Server→client request: provider runtime headers                                                  | Auto-errored by the fallback above                                                                                                                                                                                                  |
| `interaction/requestOfficialMcpAuthHeaders` (0.16.5)                                                                                                                                      | Server→client request: official MCP auth headers                                                 | Auto-errored by the fallback above                                                                                                                                                                                                  |
| `session/requestRuntimePreferences` (0.16.5)                                                                                                                                              | Runtime preference negotiation                                                                   | Wired — `backend/client.ts` auto-replies with defaults (nativeSearch/memory off, AskUserQuestion NOT auto-resolved); newer app-servers block `session/create` until it is answered                                                  |
| `session/close` (0.16.5)                                                                                                                                                                  | Actually close a backend session/runtime                                                         | Not used — remote close intentionally retires discovery only (ADR-0006, self-healing); backend runtimes idle-evict anyway                                                                                                           |
| `workspace/generateText` / `workspace/cancelGenerateText` (0.16.5)                                                                                                                        | Workspace-scoped one-shot text generation                                                        | Not used; no ACP counterpart                                                                                                                                                                                                        |
| `workspace/readState` (0.16.5)                                                                                                                                                            | Read workspace state                                                                             | Not used                                                                                                                                                                                                                            |
| `workspace/setDefaultMode` / `setDefaultModel` / `setDefaultThoughtLevel` (0.16.5)                                                                                                        | Workspace-level defaults (bridge uses per-session setters)                                       | Not used                                                                                                                                                                                                                            |
| `workspace/upsertModelProvider` / `removeModelProvider` (0.16.5)                                                                                                                          | Provider registry management                                                                     | Not used; bridge forwards the client's registry via `updateProviderRegistry`                                                                                                                                                        |
| `workspace/updateInteractionPreferences` / `workspace/updateModelIoPreferences`                                                                                                           | Client preference updates                                                                        | Not used                                                                                                                                                                                                                            |
| `skills/referenceCatalog`, `plugins/referenceCatalog`, `plugins/resolveSuggestedReference` (verified live 2026-08-27, params need `workspace.workspaceKey`)                               | Skill/plugin reference catalog lookup + suggested-reference resolution                           | Not used — the bridge reads skills and plugin commands from disk (`config/skill-discovery.ts`, `config/plugin-commands.ts`); revisit only if a client needs the backend's catalog view                                              |
| `plugins/{list,setEnabled,overview,install,uninstall,update,cancelOperation,restoreBuiltin,configure,resetConfig,validate,describe}` + `plugins/marketplace/{add,remove,update}` (3.12.3) | Full plugin management + marketplace family                                                      | Not used — **compat watchpoint**: if upstream moves plugin distribution to the marketplace, the bridge's disk-based discovery (`config/plugin-commands.ts`) may go stale                                                            |
| `offPeak/{create,list}`, `workspace/updateOffPeakToolPolicy` (3.12.3)                                                                                                                     | Off-peak (discounted-hours) task family                                                          | Not used; `session/send` carries the matching `offPeakTaskId`/`offPeakRunType` params — candidate if a client wants to schedule discounted-hours runs                                                                               |
| `automation/{create,update,list,delete,checkTaskBinding}` (3.12.3, concrete enumeration)                                                                                                  | Scheduled (cron) task family — served by the host over `automation/*` requests                   | Not planned (see below); `automation/checkTaskBinding` is new in 3.12.3                                                                                                                                                             |
| `process/childProcesses` (3.12.3)                                                                                                                                                         | List a session's child processes                                                                 | Not used; potentially useful for background-task diagnostics                                                                                                                                                                        |
| `provider/testModelConnectivity` (3.12.3)                                                                                                                                                 | Probe a provider/model endpoint                                                                  | Not used; model availability comes from the `session/create` response                                                                                                                                                               |
| `workspace/readPresentation` (3.12.3)                                                                                                                                                     | Read workspace state (successor spelling — `workspace/readState` is absent from the 3.12.3 enum) | Not used                                                                                                                                                                                                                            |
| `runtime/capabilities` + `computer-use/operation-event` (3.12.3)                                                                                                                          | Capability handshake + CUA (computer-use) operation events                                       | Not used; only meaningful once an ACP client has a CUA surface                                                                                                                                                                      |

### New `session/send` params (0.16+)

`attachments` is already wired: ACP image content blocks are extracted
(`extractAttachments`) and forwarded as `kind:"image"` entries (`localPath`
for `file://` uris, `dataBase64` otherwise). The remaining fields are not
forwarded:

- `toolDenylist` — per-message tool deny list
- `runtimeModel` — per-message model override (redundant with the bridge's
  `session/setModel` / config-option switching)
- `browserAmbientContext` — browser context for the turn
- `expectedRevision` / `expectedProviderRevision` / `expectedModelRuntimeRevision`
  — optimistic concurrency guards
- `automationId` / `offPeakTaskId` / `offPeakRunType` — scheduled/off-peak tasks

### New event types (undocumented in PROTOCOL.md)

| Event                                                                     | Notes                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `session.titleUpdated` (0.16.5)                                           | **Wired** — `SessionTitleListener` adopts `generated`/`custom` pushes          |
| `message.upserted` / `message.removed` (0.16.5)                           | Message-granular upsert/remove; the projection differ reconciles instead       |
| `part.started` / `part.delta` / `part.upserted` / `part.removed` (0.16.5) | Message-PART granular streaming (the v4 conversation model on the v3 envelope) |
| `permission.requested` / `permission.resolved` (0.16.5)                   | Interaction lifecycle OBSERVER events; the bridge serves the request methods   |
| `userInput.requested` / `userInput.resolved` (0.16.5)                     | Same, for user-input interactions                                              |
| `checkpoint.created`                                                      | Checkpoint lifecycle; pairs with `rewind.triggered`                            |
| `rewind.triggered`                                                        | A rewind happened (e.g. initiated elsewhere)                                   |
| `rewind.started` / `rewind.failed` / `rewind.completed` (0.16.5)          | Full rewind lifecycle; richer than the bare `triggered`                        |
| `streamRecovery.updated`                                                  | Stream recovery progress — potentially useful for the replay/gap-fill path     |
| `turn.attachments.resolved`                                               | Attachment resolution telemetry                                                |
| `usage.delta`                                                             | Streaming usage updates                                                        |
| `turn.steerQueued` / `turn.steerDrained`                                  | Steer lifecycle (queue/drain of steered inputs)                                |
| `turn.terminal`                                                           | Terminal turn lifecycle; bridge relies on `turn.completed`/`turn.failed`       |

Complete 3.12.3 v3 event vocabulary (from the zod envelope union): the table
above plus `session.created` / `session.resumed` / `session.updated` /
`session.closed` / `turn.started` / `turn.completed` / `turn.failed` /
`model.streaming` / `tool.updated`. Names like `task.upserted`,
`turn.phase.*`, or `session.persistence.*` appear as STRINGS in the bundle
but are v4 frames, telemetry labels, or persistence log events — not v3
`session/event` types (see the audit note above).

Unknown event types fall through the translator's else-chain untranslated and
silently — new backend events never produce noise or errors, so additions
here are informational, not blocking.

## v4 protocol family (strategic)

0.16 ships a parallel **v4** API used by the desktop client, alongside the v3
`session/*` surface this bridge speaks:

`v4/connection/flow`, `v4/controller/{subscribe,resync,unsubscribe}`,
`v4/conversation/{subscribe,resync,unsubscribe,rowsRange,plans,fileChanges,
fileRewindPreview,usage,attachmentRead,attachmentStat,frame}`,
`v4/attachment/{begin,chunk,commit,abort,read,previewSource}`,
`v4/usage/stats`, `v4/commands/query`, `v4/command`, `v4/command_fact`,
`v4/shared_context_import`, `v4/telemetry/event`,
`v4/cua/permission-observation`, `v4/fork_start_failure` (the last six
enumerated in the 3.12.3 refresh; `v4/cua/permission-observation` pairs with
the `computer-use/operation-event` server→client notification and the
`runtime/capabilities` handshake).

Steer/rewind now live here. If the bridge ever needs them back, implementing
the minimal v4 conversation subset (or `v4/command`) is the path; expect the
v3 surface to stay in maintenance mode.

## Not planned (client/config layer)

These methods belong to the desktop client or workspace configuration layer and
have no ACP equivalent. Listed for completeness only — the bridge does not
intend to surface them.

`automation/*` (scheduled tasks — the Cron* tools the backend advertises are
disallowed by default via `--disallowed-tools`, opt back in with
`ZCODE_ENABLE_AUTOMATION_TOOLS=1`; see #192), `usage/stats` (token analytics; the
account-level plan quota it does NOT cover is exposed via the bridge's own
`account/usage_stats` — see Proposal 0002), `workspace/readState`,
`workspace/upsertModelProvider`, `workspace/removeModelProvider`,
`workspace/updateProviderRegistry`, `workspace/setDefaultModel`,
`workspace/setDefaultThoughtLevel`, `workspace/setDefaultMode`,
`workspace/generateText`, `workspace/cancelGenerateText`, `mcp/list`,
`plugins/*` (the bridge reads plugin commands from disk instead).

## Verification method

The bundled CLI is minified, so a literal `grep "session/rewind"` returns 0
hits even when the method is fully supported — and vice versa, string absence
proves nothing. To audit reliably:

```sh
cd /Applications/ZCode.app/Contents/Resources/glm
# 1. Extract the RPC dispatch switch (all `case XX.method:` labels).
#    The `default:` branch throws -32601, so a method with no case is gone.
python3 - <<'EOF'
import re
src = open('zcode.cjs', encoding='utf-8', errors='replace').read()
i = src.find('case rr.sessionCreate')
start = src.rfind('switch', 0, i)
cases = re.findall(r'case (?:rr|Pc)\.([a-zA-Z]+)', src[start:start+20000])
print(' '.join(dict.fromkeys(cases)))
EOF
# 2. Confirm with a live call — the envelope has NO `jsonrpc` field:
#    {"id":1,"method":"session/steer","params":{...}} → -32601 means removed.
```

Never conclude a method was removed from a single string-literal search; a
missing dispatch case plus a live `-32601` is the proof.
