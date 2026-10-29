## Commit Messages & Communication

Write commit messages and explanations to the user in plain English for the
user.

Commit messages in this repo should read like a human explaining the change, not telegraphic shorthand. The maintainer has repeatedly pushed back on terse, abbreviated subject lines that drop the words that carry the actual intent.

Write the subject as a full, clear sentence. It may be long — that is fine — but it must name the real outcome, not a compressed label for it. For example, `fix(ui): canonical model identity, extension-refresh, drop client merges` was rejected as ambiguous jargon; `fix(ui): make server canonical for model/thinking identity across clients and extensions` was rejected as terse; the accepted form was `fix(ui): preserve the full provider/model:thinking-level identity in every browser so it is never downgraded or left stale, including when extensions change the model`. The words "preserve the full ... identity" and "never downgraded or left stale" are the point — keep that kind of language instead of collapsing it to one-word labels like "canonicalize" or "refresh".

In the body, write full sentences that explain why each change was made, not bullet fragments that only describe what changed. Keep the key framing words the user cared about ("preserve", "no downgrade", "stale") visible in the subject or the opening paragraph.

# Important Notes About the Codebase and Rabbit Holes

These tips and notes are maintained as a reference for future development. They
document the “rabbit holes” we’ve encountered before. Agents should keep them
in mind to avoid introducing features or fixes that cause regressions.

## Writing Notes Guide

When a user asks to add a note to `AGENTS.md`, capture durable project knowledge that helps future agents avoid repeating the same mistakes.

Expected content:
- The problem, edge case, or project-specific constraint, described with short detail and examples to recognize it later.
- The intended behavior or invariant to preserve, expressed in terms of outcomes.
- Relevant context about where the issue appears, if it helps identify the area in the future.

Avoid turning the note into a step-by-step implementation plan. Do not include granular patch instructions.

## Model strings are two separate fields — don't parse or split them

Pi's API always sends the model as a structured object with separate `provider`
and `id` fields (e.g. `{provider: "openrouter", id: "z-ai/glm-5.2"}`). The
provider is the backend that serves the model. The id is the model name as that
provider knows it, and it can contain slashes — `z-ai/glm-5.2` is a single
model name, not two things. Do not split the id on slashes or treat its
segments as meaningful.

When displaying the model in the UI, join them as `provider/id` — which
naturally produces `openrouter/z-ai/glm-5.2`. When adding a thinking level for
the model input box, append `:level` to the full string:
`openrouter/z-ai/glm-5.2:high`.

## Session startup and transfer safety

Create/resume return only after a successful child `get_state`; existing files
also require matching `sessionFile` and an active `get_tree` path. Initial history
must not concatenate abandoned branches. Resume's optional `args`/`env` use the
same validation as create and apply only to newly spawned children. Resume's
`started` response distinguishes the request that spawned the child from an
existing/joined tab; callers must not treat reuse as their own launch.
Resume's `refresh: true` reloads an existing idle tab's same file through native
`switch_session` and verifies state/tree before reporting `refreshed: true`, so a
retained tab does not keep stale history after another frontend wrote the file.
Busy, queued, or pending-command tabs are rejected, never cancelled or closed.
The terminal-owner guard applies to refresh too. Do not expose `switch_session`
through the generic `/api/rpc` allowlist.

A lifecycle error's `childStopped` means that request's child was confirmed gone,
not universal ownership of the file. Pre-spawn resume validation can also report
`childStopped: true`, but only with an identified path and no known live, starting,
pending-resume, closing, or terminal-registry owner. Track in-progress creates too:
they can open an existing file without appearing in `pendingResumes`. Ownership
409s, unidentified requests, and unexpected errors must not authorize rollback.
Do not infer exit from a timer, a sent signal,
a removed tab, an HTTP timeout, or an arbitrary 400 response. Uncertain children
remain tracked, deletion errors propagate, and concurrent resumes cannot bypass
pending/failed cleanup. Tests use `test/fake-pi.ts` for explicit RPC readiness and
exit events; fake children that merely survive 100 ms no longer represent startup.
Input acknowledgements refresh authoritative child state in `PiRpcSession`, even
when the HTTP/RPC caller already timed out. Handled extension commands also
rebuild the active tree; a changed file requires its bounded first-line header
for cwd because Pi's `get_state` does not expose it. Same-file commands reuse the
cached header and cwd: fresh tabs do not have a transcript until the first
message, so `/tools` or a cancelled `/take` must not require one. Snapshot reads
and the actual forwarded input completion await this synchronization. Rebuilt history is also
broadcast with the existing `live_session_snapshot` event before input completion,
so passive browser views update too. Ordinary inference keeps using streamed
events; failed synchronization never publishes a replacement. Later snapshots
retry a failed rebuild against the child instead of retaining a rejected promise
forever. Confirmed rebuilds update both snapshots and live-tab metadata for all
clients. The HTTP prompt deadline
remains only an early acknowledgement, not proof of completion. A slash command
can temporarily replace its session and roll back; keep its original file
associated with that child until state and required history are confirmed, so an
intervening `get_state` cannot make resume start a second writer. Failed refreshes
retain that association until child exit. Keep synchronization on actual child
acknowledgements, not the HTTP request's promise; no polling or switch-specific
notifications.

Focused checks: `npm run typecheck`, then `tsc -p tsconfig.server.json` and
`node --test test/pi-rpc-session.test.ts test/live-session-manager.test.ts
 test/orchestration.test.ts test/http-routes.test.ts test/session-refresh.test.ts
 test/tree-navigate.test.ts test/input-synchronization.test.ts`.

## Assistant activity blocks

Consecutive assistant thinking, text and tool calls share one visual bubble in
both live rendering and saved history. While working, collapsed blocks show only
type labels; when finished their last item is the result, without stop-reason
classification. Expansion reveals all eager DOM in chronological order. User
messages and standalone compaction entries are boundaries; `turn_end` is only a
tool-round boundary, not completion. Only `agent_end` finishes live activity.
Compaction after `self_compact` finishes the preceding block and subsequent
activity starts a fresh one. Live events are Pi 1.3's `compaction_start/end`
(the summary is `result.summary`), not the removed `auto_compaction_*` events.
No protocol or persisted UI state is involved. The session snapshot cache retains
compaction `entry_appended` entries alongside messages so reconnects preserve
boundaries. A client attaching during compaction may receive only its end event;
that event must still create a standalone compaction item and split the blocks.
Snapshots and live-tab indicators remain working through tool-round `turn_end`
events and become idle only on `agent_end`.
After compiling public TS, check `node --test test/history-render.test.ts
 test/e2e/assistant-blocks.e2e.ts test/e2e/chat-layout.e2e.ts
 test/e2e/history-render.e2e.ts`. Session event/cache regression:
`node --test test/session-events.test.ts` after compiling server TS.

## Taking a Herdr conversation

Tau may itself be launched inside Herdr or a managed Pi worker. Its children
must not inherit that terminal pane, nesting depth, target or control socket.
Keep the Herdr server socket for discovery, set the frontend to web, and apply
explicit per-child worker overrides only after clearing inherited identities.

The tab-strip arrow and command palette send `/take herdr` to the current idle
Pi child through authenticated `/api/rpc`, not through the composer. Pi-ant owns
the source picker and takeover; Tau uses its ordinary RPC extension dialog.
Drafts, attachments and browser queues must not be submitted or rewritten.
Refuse a working tab, queued input or existing dialog before dispatch. Tau may
acknowledge a prompt timeout before the picker finishes: only the child's actual
forwarded response completes the action, after the server's authoritative snapshot
broadcast. Do not fetch the same snapshot again. Apply a changed cwd to an open
file browser; late completion must not change a tab selected while the picker was
open. A handled
command can still report an error through `ctx.ui.notify` or `extension_error`;
keep structured takeover errors in the status bar through snapshot redraws,
without interpreting notification prose.
Browser regression: `node --test test/e2e/session-take.e2e.ts` after compiling
public TS. It uses a fake backend, including an early HTTP acknowledgement.

## Live-tab links

`/#session=<encoded live-tab id>` is a one-shot view selection, consumed against
initial server state or the current connected live-tab list on `hashchange`.
Do not replay it on reconnect, wait indefinitely for missing targets, resume a
file, or flush queued prompts because a URL was opened. Missing/invalid targets
show explicit feedback and preserve an existing view; an initial invalid link
must not silently select the saved/recent tab. A manual selection cancels pending
link navigation. The companion `/switch tau` opens the link only after the
started or refreshed live tab is ready. Unit/browser checks:
`node --test test/session-link.test.ts test/e2e/session-link.e2e.ts`, after
`tsc -p tsconfig.public.json`. The focused browser test serves the compiled UI
with a read-only fake backend and uses installed Chromium (`CHROMIUM_BINARY`
can override it); no Pi children or inference.

## Listeners and TLS

The network listener is HTTPS only (`src/server/tls.ts` keeps a local CA and
server certificate under `<agentDir>/tau/tls/`); plain HTTP binds only
`127.0.0.1` for local orchestration and the published endpoint. Do not add an
option to expose plain HTTP beyond loopback. Reissue server certificates with the
existing CA so devices that trusted `ca.crt` keep working. Checks:
`node --test test/tls.test.ts test/https.test.ts test/orchestration.test.ts`.

## Voice dictation

Dictation stays between the browser and the Tau server: audio and transcripts
never become Pi prompts, RPC commands, temporary files, or session entries. The
final transcript is inserted once at the textarea selection; partial text is only
previewed, so never replace or submit the draft. Session switches cancel, and every
exit releases microphone tracks, the audio context, and the socket. `voice.json` is
re-read per recording (Pi's `/dictate-setting` from pi-sound writes it); malformed
configuration is an error, and there is no fallback between backends. Settings, the
Claude login and the speech backends are pi-sound's library (`file:../pi-sound`);
change them there, never re-implement them here. Checks: `node --test
test/voice.test.ts test/voice-route.test.ts test/e2e/voice-input.e2e.ts`.
