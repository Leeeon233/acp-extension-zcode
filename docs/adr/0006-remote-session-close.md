# Remote session close: a write op on the discovery surface

Remote lists accumulated conversations the editor side had long retired: ACP
has no editor→agent "tab closed" notification, so the bridge's in-memory
`sessionSummaries` (the only membership source for both the heartbeat and
`/status`) never loses an entry once it gains activity. Until this decision
the only cleanup was a bridge restart. We decided to expose
`POST /api/instances/{id}/sessions/{sessionId}/close` — the remote HTTP
surface's first WRITE operation — which deletes the session's summary and
nothing else.

The semantics are "close", not "delete": the backend session store, the
editor's conversation storage, and the App's tasks-index are untouched. What
makes this safe where ADR-0004 kept `/fs` read-only: retiring a summary only
changes discovery visibility. Token holders can already drive arbitrary agent
work through the permission flow; a visibility toggle adds no capability.

The requested guard — "only close sessions the editor side no longer has" —
cannot be a precondition check: tab open/closed is unobservable from the
bridge (Zed sends nothing on close). It is instead enforced by the
`hasActivity` gate's natural re-arm: a closed entry loses its summary, and
`markSessionActive` — any prompt, any load with history — recreates it. A
wrongly closed conversation reappears within one heartbeat of the editor
touching it; an editor-side-retired one stays gone. The one observable
in-use signal, a pending turn, is rejected outright (409). A bridge-restart
auto-resume alone does not resurrect a closed session — `registerSession`
writes a summary with `hasActivity` unset.

Amendment (2026-10-20) — force close. The 409 guard protects conversations
from a mere list refresh, but it also blocks the client that MEANT to
terminate: a desktop user pressing "End session" on a running conversation
got the refusal and no path to act on it (observed live: the session kept
generating until the user walked to the hosting CLI window and stopped it
there). A close body `{"force":true}` now opts an explicit gesture through:
the bridge applies ESC semantics without a client connection (flag the
session's in-flight turns cancelled, fire the stop pair), waits a bounded
~3s for them to settle so the stop's terminal event persists partial output,
then proceeds with the eviction regardless — the `session/close` runtime
eviction already documented as the drain gate's kill escalation finishes any
generation that ignored the stop. Plain close keeps the refuse-when-running
contract; nothing changes for clients that send no body.

The hub stays a router (ADR-0002): the POST is forwarded by instance id and
session id only; the running guard and retirement semantics live in the
bridge. One implementation note for future write proxies: aborting the
upstream on the inbound request's `'close'` event resets the bridge socket —
an empty POST body drains and closes before the relayed response finishes
writing, so every proxied close died with ECONNRESET/502. Abort on the
RESPONSE side closing early (`res` `'close'` with `writableEnded` false)
instead.
