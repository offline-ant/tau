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
when the HTTP/RPC caller already timed out. A slash command can temporarily
replace its session and roll back; keep its original file associated with that
child until post-command state is confirmed, so an intervening `get_state` cannot
make resume start a second writer. Failed refreshes retain that association until
child exit. Do not put this refresh back in the HTTP request's promise or add
polling/switch-specific notifications.

Focused checks: `npm run typecheck`, then `tsc -p tsconfig.server.json` and
`node --test test/pi-rpc-session.test.ts test/live-session-manager.test.ts
 test/orchestration.test.ts test/http-routes.test.ts test/session-refresh.test.ts
 test/tree-navigate.test.ts`.

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

## Voice dictation

Dictation stays between the browser and the Tau server: audio and transcripts
never become Pi prompts, RPC commands, temporary files, or session entries. The
final transcript is inserted once at the textarea selection; partial text is only
previewed, so never replace or submit the draft. Session switches cancel, and every
exit releases microphone tracks, the audio context, and the socket. `voice.json` is
re-read per recording (pi-ant's `/rec-setting` writes it); malformed configuration
is an error, and there is no fallback between backends. The Claude backend mirrors
Claude Code's private `voice_stream` protocol (`TranscriptInterim`/`TranscriptText`
replace pending text, `TranscriptEndpoint` commits it) and only reads the native
login: never refresh Claude tokens here. Checks: `node --test test/voice.test.ts
test/voice-route.test.ts test/e2e/voice-input.e2e.ts`; paid live check only with
`TAU_VOICE_LIVE=1 node --test test/voice-live.test.ts`.
