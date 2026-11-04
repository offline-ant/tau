## Writing

Write in plain, simple language EVERYWHERE: **comments, docstrings, commit
messages, docs, README documentation, and explanations to the user**.

### Code, Comments & Docstrings

The text in the repo must read as the final, clean version. It should carry
no trace of the back and forth it took to get there, as if it had never been
written any other way. Describe only the current state:

- Describe only current behavior in code, docstrings and inline comments. Do
  not mention what changed or contrast it with earlier behavior.
- The only exception where record behavior changes in contract with earlier
  behavior is acceptable is in **commit messages or plans**, where readers have
  the relevant context.

### Commit Messages & Communication

Write commit messages and explanations to the user in plain English, since the
user has not read the code. Use complete sentences, not compressed jargon or
dense noun phrases. Bad: "removing pairs-order nondeterminism". Good: "results
no longer depend on the order the placeholders are listed in". Do not coin
terminology (e.g. "walk-based expander", "placeholder DSL"); say what the thing
does instead.

Commit messages in this repo should read like a human explaining the change,
not telegraphic shorthand. The maintainer has repeatedly pushed back on terse,
abbreviated subject lines that drop the words that carry the actual intent.

Write the subject as a full, clear sentence. It may be long — that is fine —
but it must name the real outcome, not a compressed label for it. For example,
`fix(ui): canonical model identity, extension-refresh, drop client merges` was
rejected as ambiguous jargon; `fix(ui): make server canonical for
model/thinking identity across clients and extensions` was rejected as terse;
the accepted form was `fix(ui): preserve the full provider/model:thinking-level
identity in every browser so it is never downgraded or left stale, including
when extensions change the model`. The words "preserve the full ... identity"
and "never downgraded or left stale" are the point — keep that kind of language
instead of collapsing it to one-word labels like "canonicalize" or "refresh".

In the body, write full sentences that explain why each change was made, not
bullet fragments that only describe what changed. Keep the key framing words
the user cared about ("preserve", "no downgrade", "stale") visible in the
subject or the opening paragraph.

## Changelog

Record only breaking changes, new features, and important bug fixes, described
as what users receive rather than how it was built. A fix belongs in the
changelog only when the bug shipped in an earlier version; bugs in features
still under development stay out.

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

## Record pitfalls, not a description of the code

This file records only pitfalls that the code does not make obvious. Do not note
implementation details, repeat what the code already shows, or write long
descriptions. Those details go stale and bury the warning. Record an outcome
only when it is a hard contract that must be preserved, not when the code
already makes it clear. Do not fill the file with obvious outcomes, and do not
spell out an obvious outcome at length.

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

## Keep browser tests bounded

Close each browser page when its test ends. Separate synthetic rendering tests
from real detached-runtime tests; the latter wait for owned Pi startup/exit and
need a longer timeout. Never run a personal daemon or paid provider to make an
integration test pass.

## Detached runtime and uncertainty

The Tau process never owns Pi lifetime. Agent Close is an unconfirmed,
identity-bound stop in every frontend. Browser/server shutdown and internal view
cleanup only disconnect; never replace those cleanup paths with global stop.
Worker Close requires an advertised cancellation command and matching final parent
task cleanup evidence, not dispatch or runtime exit alone. Parent web-host DELETE
must disconnect without removing a pending or failed worker view. Reconnect reads
retained task evidence even after Tau restarts, using the captured socket namespace.
A committed runtime remains after attach failure. Failed or uncertain starts retain operation
identity and cannot justify another spawn. A refused socket, HTTP timeout, removed
tab or sent signal never proves the writer is gone. `force` does not bypass claims.

Every tab, including one created here, publishes one complete pimux snapshot/replay/
live boundary. Never concatenate `get_entries`/`get_messages` reads with replay or
close a shared dialog merely because a run settled. A newer generation discards an
unfinished older sequence. Queue clearing affects every frontend, but acknowledged
recovery belongs only to the requester and the original file/leaf context. Input
with uncertain delivery is recoverable, never automatically resent.

A session process is a connection, not ownership of `piPid`. Worker lifetimes use
exact parent process/start/boot identity and task ID. A creator is not privileged.
Retained old-file claims must refuse rather than route commands into a runtime now
serving another conversation. Live export must use that Pi's in-memory exporter:
the transcript's last entry can differ from its selected leaf after tree navigation.

Stopped-file operations need a lease over their whole read/validate/mutate
transaction. Raw Pi 1.4 internal storage bypasses remain outside the cooperative
guarantee; do not describe all disk mutations as universally protected.

Focused checks: `npm run typecheck`, explicit compilation, and
`node --test test/close-worker.test.ts test/runtime-recovery.test.ts
 test/detached-runtime.test.ts test/pimux-attach.test.ts test/session-export.test.ts`.
The explicit real-runtime lane is `node --test test/detached-runtime-native.test.ts
 test/e2e/worker-close-native.e2e.ts`.

## Browser connections

`liveManager.sendTo` is the only way to send to a browser after its first record: one
that stopped reading is terminated at `MAX_CLIENT_BACKLOG_BYTES` and recovers through
a snapshot on reconnect, so Tau never buffers for it without bound. Status text comes
from `connectionStatusText()`, never a literal: HTTP can succeed while the WebSocket
that carries events is down.

`src/public/sw.ts` lists every module by hand (`test/service-worker.test.ts` checks
it). Bump `CACHE_NAME` with each deployed change to `src/public`.

Authentication is enabled unless `tau.authEnabled` is explicitly `false`.
There are no default credentials: `listen()` validates a nonempty configured user
and password before creating TLS assets or opening either listener. Empty
`TAU_USER`/`TAU_PASS` override settings but never disable authentication. Keep the
explicit opt-out and the configured runtime `set_auth` toggle; missing credentials
must not produce an implicitly open server.

Only the exact normalized `/api/health` skips authentication (`isPublicRequest`).
Compare request paths after URL normalization, never by raw prefix.

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
configuration is an error, and there is no fallback between backends. The public
pi-sound opener is asynchronous and accepts an AbortSignal. A backend can resolve
after cancellation or invoke its error callback before resolving: close any late
transcriber without emitting ready or another terminal result. Voice is disabled
without an explicit backend, and browser PCM never authorizes native credential,
capture-device or socket discovery. Checks: `node --test
test/voice.test.ts test/voice-route.test.ts test/e2e/voice-input.e2e.ts`.
