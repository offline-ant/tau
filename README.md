# Pi Tau Web Server

**Browser workspace for [Pi](https://github.com/earendil-works/pi) — a standalone web server that manages multiple live Pi RPC sessions in parallel.**

> **This checkout is a fork** of [milanglacier/pi-tau-web-server](https://github.com/milanglacier/pi-tau-web-server)
> (remote `upstream`, branch `pi-orchestration`). It adds orchestration support for
> pi-ant: tau acts as a *web host* for Pi workers, and never becomes a second writer
> on a session file a terminal worker owns. See [Orchestration host](#orchestration-host).
> Authentication requires explicitly configured HTTP Basic credentials. Tau refuses
> startup without them unless `tau.authEnabled` is explicitly `false`.

Pi Tau Web Server is a fork of [deflating/tau](https://github.com/deflating/tau), forked at
[`5e2bce39`](https://github.com/deflating/tau/tree/5e2bce39) and rewritten from
a Pi extension that ran inside the Pi TUI into a standalone Node.js web server.
The original Tau project was retired on 2026-09-30 and is no longer maintained.
This private integration candidate keeps upstream maintenance and the fork's
browser/orchestration features. One detached pimux owns each Pi RPC agent; Tau
and Pilish are equal Unix-socket clients. Closing a tab or restarting Tau only
disconnects its views. Explicit **Stop agent everywhere** ends the agent.

## Key differences from `5e2bce39`

| Area                  | Upstream (`5e2bce39`)                                                                         | This fork                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Architecture** | Pi extension inside a terminal | Standalone HTTP/WebSocket server and equal clients of detached agents |
| **Multiple sessions** | One terminal conversation | Independent agents, with several frontend views of each |
| **Session lifecycle** | Bound to the terminal | Bound to the detached runtime, not its creating frontend |
| **Pi communication** | In-process extension API | JSONL RPC over protected Unix sockets |
| **UI dialogs** | Terminal only | Shared dialogs with first-answer-wins closure |
| **Auto-start** | Inside Pi | Explicit server and agent launch |
| **Session tree** | Terminal navigation | Capability-checked navigation, branching and complete exports |

![Tau light mode](docs/images/main-page.jpg)

![Tau dark mode](docs/images/main-page-dark.jpg)

![New tab modal](docs/images/new-tab.jpg)

![Commands](docs/images/commands.png)

![Model completion](docs/images/model-completion.jpg)

![Settings](docs/images/settings.png)

![Mobile main page](docs/images/mobile-main-page.jpeg)

![Mobile sidebar](docs/images/mobile-side-bar.jpeg)

## What it does

- Runs several Pi agents and shows the same live agent from several browsers or Emacs.
- Keeps accepted work running with zero connected clients; never restarts crashed
  agents or resends uncertain input automatically.
- Browses saved sessions by project, with lazy loading, search and read-only
  following of terminal-owned conversations.
- Provides shared dialogs, model/thinking controls, rich tool output, queue
  recovery, images, an optional file browser and optional public voice dictation.

## Install

This is an unpublished Phimacs candidate, not the upstream npm package. It needs
Linux, Node 24 and its exact Pi 1.4.0 host. The release installs the complete tested
runtime; it does not use or modify an unrelated global Pi.

For candidate development, audited compiled pimux and generic sound archives are
included in `vendor/` and locked with integrity hashes. Run
`npm ci --ignore-scripts`, then the explicit compilation commands below. Installing
never builds or downloads assets through a lifecycle script. Public redistribution
remains gated on the complete release matrix and the upstream license clarification.

## Usage

Configure authentication first (see [Authentication](#authentication)), or supply
credentials when starting:

```bash
TAU_USER=pi TAU_PASS='choose-a-password' pi-tau-web-server
```

Open the printed URL (default `https://localhost:3443`). Click `+` in the tab bar or sidebar to create an in-page Tau tab, choose or type a project directory, optionally enter a Pi `/model`-style model string, then chat.

```bash
pi-tau-web-server --host 127.0.0.1 --port 3443 --open
TAU_PORT=3443 TAU_HOST=0.0.0.0 TAU_PROJECTS_DIR="$HOME/projects" pi-tau-web-server
```

### HTTPS

The network listener (`--host`/`--port`, default `127.0.0.1:3443`) always speaks
HTTPS; browsers need a secure context for the microphone. Plain HTTP exists only
on loopback (`127.0.0.1`, `--http-port`, default `3001`) for local Pi
orchestration and is never reachable from the network. Both listeners share the
same routes, WebSockets and authentication.

On first start Tau creates a small local certificate authority under
`<PI_CODING_AGENT_DIR>/tau/tls/` (directory `0700`, keys `0600`) and prints the
path of its `ca.crt`. Install that file once as a trusted CA on each phone or
browser to avoid certificate warnings. The server certificate (825 days, signed
by that CA) covers `localhost`, the machine's host name, names listed in
`hostnames`/`TAU_HOSTNAMES`, `127.0.0.1`, `::1` and every non-link-local
interface address. It is reissued by the same CA at startup when those names or
addresses change or expiry is within 30 days, so installed trust survives.
Certificates are signed with the `openssl` CLI, which must be on `PATH`.

## Containers

The container launcher runs one isolated Tau service per instance name. Docker
and Podman are supported; set `TAU_CONTAINER_RUNTIME` to select one explicitly.
The image is built automatically on the first run, or it can be built ahead of
time:

```bash
container/tau-container build
```

Start an instance with credentials in the environment:

```bash
TAU_USER=alice TAU_PASS='choose-a-password' \
  container/tau-container run personal-workspace --port 3443
```

Missing credentials are prompted for, with the password input hidden. Start
additional isolated instances by giving each one a different name and host
port:

```bash
container/tau-container run work-workspace --port 3444
container/tau-container status
container/tau-container logs work-workspace
container/tau-container stop work-workspace
```

Each instance has an isolated `~/projects` directory inside the container,
available at `/state/home/projects`. It is mounted read-write from the
instance's `projects/` state directory.

On an instance's first launch, the launcher copies
`${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}` into that instance's writable state.
Symlinks are dereferenced on the host. The host `sessions/`, `npm/`, and `git/`
directories are excluded. Package declarations remain in `settings.json`, so Pi
installs missing npm/git packages when its first RPC session starts.

The copied configuration is never refreshed automatically. Changes made by Pi
or Tau therefore survive container recreation and remain isolated from other
instances. Projects and session files are also stored separately per instance.
By default, state is kept under:

```text
${XDG_DATA_HOME:-$HOME/.local/share}/pi-tau-web-server/instances/<instance>/
```

The host-side projects directory is `<instance>/projects/` beneath that path.
Override the state root with `TAU_CONTAINER_STATE_DIR`.

Ports bind to all host interfaces by default and serve HTTPS with the
instance's own certificate authority, stored in its state under
`agent/tau/tls/ca.crt`. Pass `--bind 127.0.0.1` to restrict an instance to local
access.

## Features

### Chat

- Full markdown rendering with syntax-highlighted code blocks
- Assistant activity shares one bubble: while working, a growing list of step types (`thinking · bash · bash · text`); when finished, only the last item is shown. Click the list to reveal all steps in order. Long lists keep the latest eight labels with an earlier-step count.
- Expanded blocks stream their full content; collapsed blocks show only activity labels until completion. User messages and context compaction stay separate; compaction starts a new block.
- Expand/Collapse All Steps commands; thinking visibility also controls thinking labels.
- Image attachments (paste, drag & drop, or button)
- Copy any message with one click
- Inline diff viewer for edit tool calls
- Message queuing while the agent is working
- **Voice dictation** — tap the microphone to record, tap again to stop. The
  browser streams 16 kHz PCM to the authenticated `/ws/voice` socket; the final
  transcript is inserted once at the cursor and never sent. Switching or closing
  the tab cancels. Browsers require HTTPS (or localhost) for the microphone,
  which Tau's network listener provides (see [HTTPS](#https)).
  Voice is disabled until an approved backend is explicitly configured in
  `<PI_CODING_AGENT_DIR>/voice.json`, for example:

  ```json
  {"backend":"local","options":{"url":"http://127.0.0.1:8090"},"mode":"type"}
  ```

  The public `pi-sound` library supplies the asynchronous transcriber contract.
  Browser audio needs no capture driver. Tau never reads native subscription
  credentials, chooses a device socket or silently falls back to another backend.
  English only; 5-minute recording, 64-KiB frames and 15-second silence limits apply.

### Live Session Management

- Detached Pi RPC runtimes shared by equal Tau/Pilish views
- JupyterLab-style in-page Tau tab strip — each tab is an independent Pi session
- Browser reload or reconnect restores live Tau tabs from the backend
- Multiple browser clients see the same live session list
- Historical sessions remain read-only
- **Agents** — the header button (its count shows blocked agents) lists every Pi shared through pimux, such as Emacs Pilish sessions: grouped by directory, workers under their parent, blocked first, then working, done, idle. Tapping one attaches a tab; see [Shared agents](#shared-agents-pimux).
- **Take from Herdr…** — use the arrow beside the Tau tabs or the command palette to select an idle Herdr conversation and load it into the current Tau tab. Requires pi-ant's `/take` command and an idle tab with no queued messages or pending dialogs. The existing RPC picker handles selection; drafts, attachments, and other tabs' queues stay untouched.
- **Session tree and branching** — inspect the active session's full tree and jump to any earlier entry, mirroring Pi TUI's `/tree` behavior; choose a user message to restore it to the composer and create a new branch
- **Live-tab links** — `/#session=<URL-encoded live-tab id>` selects an existing
  live tab after connection, or when the URL fragment changes. Links contain no
  credentials or session-file paths. They never resume historical files or submit
  prompts; queued input stays paused until you select a tab normally or submit
  input yourself. Missing/malformed links report an error without selecting a
  fallback tab or waiting to select a future matching tab. Once handled, the
  session fragment is removed, including invalid/missing targets; path, query and
  unrelated fragments stay unchanged. Reconnect does not reapply an old link,
  and reload restores your last selected tab normally.

### Model & Thinking

- Optional model string at session creation using Pi `/model` syntax (e.g. `openai/gpt-5.5:high`)
- Per-session model picker with fuzzy search
- Per-session thinking level controls
- Token usage percentage with context window visualiser
- Cost tracking per session

### File Browser

- Right sidebar rooted at the active live session's working directory
- Navigate directories, open files natively
- Drag files onto the input to insert their path

### Session Browser

- Sidebar listing every project that has saved Pi JSONL sessions, collapsed by default
- Expanding a project loads its sessions; `+` on a project header starts a new session there
- Rename sessions, export to HTML
- Search filters titles across all projects, including collapsed projects and older sessions. With two or more characters, it also searches saved message text and shows up to 30 matching sessions, each with the first snippet and a match count capped at three. Matches are literal and case-insensitive. Clearing the search restores the usual ten-row/show-all view; ordinary browsing still loads session lists only on demand (or for favourites).
- Opening a search match uses the normal session controls: shared agents attach, terminal-owned sessions open read-only, and other sessions resume through the server's ownership checks.

### Mobile Support

- Slide-over sidebar with swipe-from-edge gesture
- Slimmed header, model picker stays accessible
- Larger touch targets and font sizes optimized for mobile
- Auto-reconnect WebSocket on return from background
- Fullscreen by default on touch devices: entered on the first tap (browsers require a gesture); turning it off in Settings is remembered. iPhone Safari has no page fullscreen, so Settings suggests adding Tau to the Home Screen instead
- The layout follows the visible viewport, so the composer and latest message stay above the on-screen keyboard, including in fullscreen where browsers do not resize the page
- PWA: installable as a fullscreen app (standalone where fullscreen is unsupported, e.g. iOS)

### Themes

Chat uses messenger-style bubbles: your messages on the right and grouped agent activity on the left, each with a tail. Tool details live inside their assistant block.

Seven built-in themes: Telegram (default: blue header, white agent bubbles, light blue user bubbles on a faint doodle wallpaper), Dusk (clean neutral dark), Dawn (warm blue dark), Midnight (OLED black), Clean (Apple-style light with cyan-blue accents), Terracotta (warm light), Sage (warm olive-green). Only an explicit choice in Settings is remembered; otherwise Telegram applies.

## Configuration

### CLI flags

| Flag                                  |                                                  Description |
| ------------------------------------- | -----------------------------------------------------------: |
| `--open`                              |                 Open the URL in the default browser on start |
| `--port` / `TAU_PORT`                 |                                 HTTPS port (default: `3443`) |
| `--host` / `TAU_HOST`                 |                      HTTPS bind address (default: `127.0.0.1`) |
| `--http-port` / `TAU_HTTP_PORT`       |               Loopback-only plain HTTP port (default: `3001`) |
| `--projects-dir` / `TAU_PROJECTS_DIR` | Directory scanned for project chips in the new-session modal; also the base for relative paths typed in the project field |
| `--pi-command` / `TAU_PI_COMMAND`     |                     Absolute supported release Pi (default: installed SDK) |

### Environment variables

| Variable           |     Default |                                              Description |
| ------------------ | ----------: | -------------------------------------------------------: |
| `TAU_PORT`         |      `3443` |                                               HTTPS port |
| `TAU_HOST`         | `127.0.0.1` |                                       HTTPS bind address |
| `TAU_HTTP_PORT`    |      `3001` |                            Loopback-only plain HTTP port |
| `TAU_HOSTNAMES`    |    _(none)_ |      Comma-separated extra certificate/browser host names |
| `TAU_PROJECTS_DIR` |    _(none)_ | Directory scanned for project chips in the new-tab modal |
| `TAU_PI_COMMAND`   | _(installed SDK)_ |                              Pi executable that Tau runs |
| `TAU_STATIC_DIR`   | _(bundled)_ |                               Override static files path |
| `TAU_USER`         |    _(none)_ |                  Required nonempty Basic Auth username |
| `TAU_PASS`         |    _(none)_ |                  Required nonempty Basic Auth password |
| `TAU_COOKIE_SECRET`| _(generated)_ |            Secret that signs session cookies (optional) |
| `TAU_INTERACTION_DIAGNOSTICS` | _(off)_ | Set to `1` to log dialog/Abort lifecycle IDs, reasons, and timestamps to stderr |

Tau also reads matching values from `~/.pi/agent/settings.json` under the `tau` key (`host`, `port`, `httpPort`, `hostnames` (array), `projectsDir`, `user`, `pass`, `authEnabled`, `cookieSecret`).

### Selecting the release Pi

`--pi-command` overrides `TAU_PI_COMMAND`. The value must be one absolute
executable belonging to the supported Pi package, not a shell command, PATH name
or arbitrary wrapper. The default resolves this installation's Pi SDK entry.
`PHIMACS_PI_VERSION` and `PHIMACS_PI_SHA256` enforce release metadata. Every launch,
model listing and export rechecks the selected host; mismatch refuses before I/O.
Set `PI_CODING_AGENT_DIR` to choose a separate state directory.

```sh
pi-tau-web-server --pi-command /absolute/release/node_modules/.bin/pi
```

### Authentication

Tau Web Server uses HTTP Basic Auth by default and has **no default credentials**.
Set a nonempty username and password in `~/.pi/agent/settings.json` or with
`TAU_USER` and `TAU_PASS`. Environment values override settings, including empty
strings: an empty or missing credential causes startup to fail before either
listener opens, rather than silently disabling authentication.

```json
{
  "tau": {
    "user": "pi",
    "pass": "your-password"
  }
}
```

To deliberately run without authentication, set `"authEnabled": false` under
`tau` in settings.json. This is the only startup opt-out; empty credential values
are not an opt-out. This exposes the UI and session-spawning API to everyone who
can reach either listener, so choose the bind address/network access accordingly.
With credentials configured, Tau Settings can still toggle "Require login" and
persists that choice. Without credentials, enabling it is rejected: configure
credentials and restart first. Credential changes take effect on the next restart.

Both HTTP and WebSocket connections are gated when enabled. Only the exact path `/api/health` remains open for monitoring.

After the first successful Basic login, the server sets a signed `HttpOnly` session cookie and accepts it in place of the Authorization header. This keeps mobile browsers (notably iOS Safari and the installed PWA, which evict cached Basic credentials whenever you switch apps) from re-prompting for the password every time you return to the app. The cookie is scoped to the browser session — killing the browser ends it and the Basic prompt appears again — and the token inside it expires after 12 hours of inactivity, renewing itself while the app is in use. Changing the password invalidates every outstanding cookie on all devices, and deleting the auto-generated `cookieSecret` from `~/.pi/agent/settings.json` force-logs-out all devices at once.

## Orchestration host

Phimacs orchestration can start workers through this web host. Create/resume
accept validated `sessionFile`, `args` and `env` overrides; session-opening flags
inside `args` are rejected in favor of the exact file field. A worker additionally
requires `PHIMACS_PARENT_TASK` with its parent's exact process/start/boot identity
and task ID. Workers remain parent-task-owned; closing a frontend does not promote
them into independent roots. Tau has no host-native shell panels.

The private `<agentDir>/tau/server.json` advertises the loopback orchestration
endpoint and credential-free HTTPS browser URLs. It is not a writer lock.
Terminal registry owners are shown read-only. A common atomic claim protects all
cooperating managed opens; `force:true` cannot bypass a live or uncertain native,
unsupported or RPC owner. Raw Pi/internal storage paths outside the managed API
remain an explicit upstream safety limitation.

## Shared agents (pimux)

All Tau roots use compiled `@phimacs/pimux` protocol 2. Create/resume have one
attach-or-start path: an existing tab, a compatible existing runtime, or an
atomically claimed new runtime. They wait for committed companion readiness and
an authoritative snapshot/replay/live boundary, not a listening socket or timer.
Failed/uncertain startup retains operation evidence; it never triggers a second
writer. A failed frontend attach after commitment leaves the agent discoverable.

- **Discovery:** `GET /api/agents` and WebSocket `pimux_agents` list shared agents,
  grouping workers under parents and sorting blocked agents first. Unsupported
  or unreachable live owners are refusals, not permission to spawn.
- **Attach:** `POST /api/live-sessions/attach {"muxId":"…"}` opens an equal view.
  Every selection/reconnect requests a complete snapshot. Only its own
  `pimux_live` publishes a generation; superseded partial sequences are discarded.
- **Disconnect:** `DELETE /api/live-sessions/:id`, closing a tab and Tau shutdown
  disconnect views only. A runtime with zero clients continues already accepted
  work and may incur provider usage. A lost connection never infers a restart.
- **Stop:** confirmed `POST /api/live-sessions/:id/stop` or
  `POST /api/agents/:muxId/stop` accepts `{confirm:true,operationId?}`. It returns
  an identity-bound `receipt.state:"stopped"` after actual owned Pi exit. Retained
  receipts reconcile lost acknowledgements against that runtime, not a new owner.
  Idle agents have the same explicit stop action. No client signals a raw Pi PID.
- **Input:** busy sends steer; all clients see authoritative Pi-held queues and
  first-answer dialog closure. New session replaces the conversation everywhere.
  Drafts/images/local pending input are quarantined under agent/file/leaf identity
  when context changes. Explicit Reuse is required; uncertain input is never resent.
- **Queue recovery:** clearing/aborting affects the global Pi queue, including
  input from other clients. Only the requester receives acknowledged recovered
  text, bound to its original context. Other views never claim per-client recovery.
- **Capabilities:** tree navigation is offered only when the runtime advertises its
  owning command. Root operations are not privileged by which frontend created it.
  Workers retain their session-replacement restrictions.
- **Files:** rename uses the live owning Pi; live deletion refuses. Stopped-file
  reads/mutations/exports use short common ownership leases. Live HTML export uses
  Pi's owning in-memory exporter so the exact selected leaf and full tree survive.
- **Refresh:** an attached view refreshes its authoritative runtime boundary; it
  never reopens a live session file. The selected branch is the runtime's branch.

`started:true` identifies a newly launched runtime, not a newly created view.
Failure `childStopped` is only request-local evidence: `false` after a committed
attachment failure, and never proof that every possible owner is gone. Timeouts,
sent signals, removed tabs and ordinary HTTP errors do not authorize rollback.

## How it works

```text
Browser -> Tau --------socket--+-> detached pimux -> exact release Pi (RPC)
Emacs -> Pilish -------socket--+
```

Tau holds view state and bounded browser queues; pimux owns process lifetime,
claims, snapshots and stop. There is no central agent scheduler or creator role.

For diagnosis, `TAU_INTERACTION_DIAGNOSTICS=1` logs dialog creation/resolution and Abort sent/acknowledged/timed-out events. These opt-in records exclude command arguments, dialog text, credentials, and conversation content. Live request IDs are never stored in the conversation history or restored after a Pi process restart.

## Development

### Prerequisites and explicit checks

Use Node 24 and the locked local input archives, not sibling source checkouts or
developer globals. Keep browser assets and the optional tree extension in packs.

```sh
npm ci --ignore-scripts
npm run typecheck
node_modules/.bin/tsc -p tsconfig.server.json
node_modules/.bin/tsc -p tsconfig.public.json
node scripts/copy-katex.ts
node scripts/copy-highlight.ts
chmod u+x bin/tau.js
node --test test/detached-runtime.test.ts test/detached-runtime-native.test.ts
node --test test/voice.test.ts test/voice-route.test.ts
node --test test/e2e/pimux-share.e2e.ts
```

Focused backend/browser tests use synthetic sessions, fake peers or faux providers,
private HOME/agent/discovery/claim roots and disposable loopback servers. Never
point them at a personal daemon, account, device socket or live session. The
cross-frontend release matrix also uses a separately provisioned reference Emacs;
a personal Emacs cache is not clean-install evidence. See
[the candidate input record](docs/phimacs-candidate.md).

## License

MIT
