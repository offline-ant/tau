# Pi Tau Web Server

**Browser workspace for [Pi](https://github.com/earendil-works/pi) — a standalone web server that manages multiple live Pi RPC sessions in parallel.**

> **This checkout is a fork** of [milanglacier/pi-tau-web-server](https://github.com/milanglacier/pi-tau-web-server)
> (remote `upstream`, branch `pi-orchestration`). It adds orchestration support for
> pi-ant: tau acts as a *web host* for Pi workers, and never becomes a second writer
> on a session file a terminal worker owns. See [Orchestration host](#orchestration-host).
> It also ships default HTTP Basic credentials, so the default `0.0.0.0` bind is
> authenticated out of the box.

Pi Tau Web Server is a fork of [deflating/tau](https://github.com/deflating/tau), forked at
[`5e2bce39`](https://github.com/deflating/tau/tree/5e2bce39) and rewritten from
a Pi extension that ran inside the Pi TUI into a standalone Node.js web server.
Instead of living inside a TUI session, Tau runs one backend process and spawns
headless `pi --mode rpc` child processes — one per in-page Tau tab — so you can
work with multiple Pi sessions side by side in your browser.

## Key differences from `5e2bce39`

| Area                  | Upstream (`5e2bce39`)                                                                         | This fork                                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Architecture**      | Pi extension loaded inside the Pi TUI process; browser displayed a single running TUI session | Standalone Node.js server that spawns independent `pi --mode rpc` child processes                              |
| **Multiple sessions** | Not supported                                                                                 | In-page tabs each backed by their own Pi RPC subprocess; run N sessions in parallel                            |
| **Session lifecycle** | Tied to the Pi TUI session — close the TUI and the browser view died                          | Sessions are server-owned; closing/reloading the browser does not kill Pi children                             |
| **Pi communication**  | In-process Pi extension API                                                                   | Out-of-process JSON line-delimited RPC over stdin/stdout                                                       |
| **UI dialogs**        | `ctx.ui.confirm/input/select` shown in TUI only; not forwarded to the browser                 | All forwarded to the browser — extensions that use these built-in UI interfaces work seamlessly in the browser |
| **Test coverage**     | Javascript and No tests                                                                       | Typescript + Full test suite                                                                                   |
| **Auto-start**           | Extension auto-started inside Pi unless `TAU_DISABLED=1`                                      | Always explicit — the user runs `pi-tau-web-server` when they want it                                          |
| **Various enhancements** | N/A                                                                                           | Session tree and branching, mirroring Pi TUI's `/tree` command                                                  |

![Tau light mode](docs/images/main-page.jpg)

![Tau dark mode](docs/images/main-page-dark.jpg)

![New tab modal](docs/images/new-tab.jpg)

![Commands](docs/images/commands.png)

![Model completion](docs/images/model-completion.jpg)

![Settings](docs/images/settings.png)

![Mobile main page](docs/images/mobile-main-page.jpeg)

![Mobile sidebar](docs/images/mobile-side-bar.jpeg)

## What it does

- **Standalone server** — run `pi-tau-web-server`; it serves the web UI and manages Pi RPC child processes as subprocesses via `pi --mode rpc`
- **Multiple live sessions** — in-page Tau tabs (not browser tabs) each represent a live Pi RPC session. Create, switch, and close them from one browser page. Tau runs all of them in parallel.
- **Session persistence while the server runs** — closing or reloading the browser does not kill Pi child sessions; only closing an in-page Tau tab or shutting down the Tau server does
- **Works on any device** — open the same Tau server from your phone, tablet, or another monitor
- **Session history browser** — browse saved Pi JSONL session files by project, loading a project's sessions when it is opened
- **WebSocket-based client-server architecture** — the browser connects to Tau over HTTP and WebSocket; Tau communicates with Pi processes over JSON line-delimited RPC over stdin/stdout

## Install

Requires Node.js 22.19 or newer and [Pi](https://github.com/earendil-works/pi)
installed as the `pi` command on your `PATH`.

```bash
npm install --global pi-tau-web-server
```

## Usage

```bash
pi-tau-web-server
```

Open the printed URL (default `https://localhost:3443`). Click `+` in the tab bar or sidebar to create an in-page Tau tab, choose or type a project directory, optionally enter a Pi `/model`-style model string, then chat.

```bash
pi-tau-web-server --host 127.0.0.1 --port 3443 --open
TAU_PORT=3443 TAU_HOST=0.0.0.0 TAU_PROJECTS_DIR="$HOME/projects" pi-tau-web-server
```

### HTTPS

The network listener (`--host`/`--port`, default `0.0.0.0:3443`) always speaks
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
  Settings and speech backends come from the sibling
  [pi-sound](../pi-sound) package (`file:../pi-sound` dependency; compile it
  before installing Tau). The backend is read from
  `<PI_CODING_AGENT_DIR>/voice.json` at each recording: `claude` (default;
  Claude Code's subscription speech endpoint, using the pi-claude-agent default
  account's Claude login, never refreshed) or `local` (any OpenAI-compatible
  `/v1/audio/transcriptions` server); choose it with Pi's `/dictate-setting`.
  English only; no fallback. Terminal and Emacs dictation are pi-sound's.

### Live Session Management

- Backend-owned live Pi RPC sessions, each backed by a `pi --mode rpc` subprocess
- JupyterLab-style in-page Tau tab strip — each tab is an independent Pi session
- Browser reload or reconnect restores live Tau tabs from the backend
- Multiple browser clients see the same live session list
- Historical sessions remain read-only
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
| `--host` / `TAU_HOST`                 |                      HTTPS bind address (default: `0.0.0.0`) |
| `--http-port` / `TAU_HTTP_PORT`       |               Loopback-only plain HTTP port (default: `3001`) |
| `--projects-dir` / `TAU_PROJECTS_DIR` | Directory scanned for project chips in the new-session modal |

### Environment variables

| Variable           |     Default |                                              Description |
| ------------------ | ----------: | -------------------------------------------------------: |
| `TAU_PORT`         |      `3443` |                                               HTTPS port |
| `TAU_HOST`         |   `0.0.0.0` |                                       HTTPS bind address |
| `TAU_HTTP_PORT`    |      `3001` |                            Loopback-only plain HTTP port |
| `TAU_HOSTNAMES`    |    _(none)_ |      Comma-separated extra certificate/browser host names |
| `TAU_PROJECTS_DIR` |    _(none)_ | Directory scanned for project chips in the new-tab modal |
| `TAU_STATIC_DIR`   | _(bundled)_ |                               Override static files path |
| `TAU_USER`         |        `rs` |                                 HTTP Basic Auth username |
| `TAU_PASS`         |         `l` |                                 HTTP Basic Auth password |
| `TAU_COOKIE_SECRET`| _(generated)_ |            Secret that signs session cookies (optional) |

Tau also reads matching values from `~/.pi/agent/settings.json` under the `tau` key (`host`, `port`, `httpPort`, `hostnames` (array), `projectsDir`, `user`, `pass`, `authEnabled`, `cookieSecret`).

### Authentication

Tau Web Server supports HTTP Basic Auth. This fork ships **default credentials `rs` / `l`**, so auth is enabled out of the box and the default `0.0.0.0` bind is never an unauthenticated session-spawning API. Replace them in `~/.pi/agent/settings.json` or via environment variables, then toggle "Require login" in Tau Settings. Setting `TAU_USER`/`TAU_PASS` (or the settings keys) to an empty string leaves auth unconfigured and disabled.

```json
{
  "tau": {
    "user": "pi",
    "pass": "your-password"
  }
}
```

Both HTTP and WebSocket connections are gated when enabled. `/api/health` remains open for monitoring.

After the first successful Basic login, the server sets a signed `HttpOnly` session cookie and accepts it in place of the Authorization header. This keeps mobile browsers (notably iOS Safari and the installed PWA, which evict cached Basic credentials whenever you switch apps) from re-prompting for the password every time you return to the app. The cookie is scoped to the browser session — killing the browser ends it and the Basic prompt appears again — and the token inside it expires after 12 hours of inactivity, renewing itself while the app is in use. Changing the password invalidates every outstanding cookie on all devices, and deleting the auto-generated `cookieSecret` from `~/.pi/agent/settings.json` force-logs-out all devices at once.

## Orchestration host

pi-ant's orchestration package starts Pi workers on a *host*: tmux, Herdr, Emacs,
or — with this fork — tau. A web-hosted worker is an ordinary live tab: you watch
it stream in the browser, and its prompts are RPC commands rather than keystrokes,
so there is no terminal draft to disturb.

Three pieces make that work:

- **Programmatic spawn.** `POST /api/live-sessions` accepts `sessionFile`, `args`,
  and `env` next to `cwd` and `model`, so a caller runs the child with its own
  session file, model flags, and environment. `args` is appended after tau's own
  arguments; `sessionFile` must live under Pi's session directory.
  `POST /api/live-sessions/resume` accepts `filePath`, optional `cwd`/`model`,
  and the same `args`/`env` overrides. Resume reuses an existing live tab or joins
  an in-progress resume of that file; overrides apply only when a child is spawned.
  A successful resume returns `started: true` only to the request that spawned
  the child; reuse/join returns `started: false, reused: true`.
  With optional `refresh: true`, an existing idle tab for that file reloads it
  through Pi's native same-file `switch_session`, verifies state and active tree,
  replaces its cached history, and returns `started: false, reused: true,
  refreshed: true`. A streaming tab, queued prompts, or pending mutating commands
  reject the refresh without cancelling anything or closing the tab. Arbitrary
  `switch_session` remains unavailable through `/api/rpc`.
  Resume restores the child's selected branch, not every abandoned branch in the file.
- **Discovery.** While running, the server writes `~/.pi/agent/tau/server.json`
  (mode `0600`) containing its endpoint URL, with HTTP Basic credentials in the
  URL userinfo when auth is configured, and credential-free `browserUrls`. The
  endpoint is always the loopback plain HTTP listener; `browserUrls` are HTTPS
  origins derived from the actual HTTPS listener: configured `hostnames` first,
  then reachable numeric addresses such as a WireGuard IP. A Pi session started anywhere on the
  machine can then select this server with `/orchestration-host web`. A second
  concurrent server does not overwrite the first one's record; target it with
  `PI_ORCHESTRATION_ENDPOINT`. Children tau spawns inherit
  `PI_ORCHESTRATION_HOST=web` and that endpoint directly.
- **Ownership.** Workers on a *terminal* host register themselves in
  `$TMPDIR/pi-orchestration-targets`. Tau reads that registry, marks those
  sessions `owner` in `GET /api/sessions`, and answers `POST
  /api/live-sessions/resume` with `409` instead of attaching a second `pi`
  process to a file another one is appending to. The UI opens such a session
  read-only and re-reads it while it grows; `GET
  /api/sessions/:project/:file?since=<byte offset>` serves those incremental
  reads. The registry is advisory — a crashed orchestrator leaves its record
  behind — so `{"force": true}` still resumes.

Create/resume succeed only after Pi answers `get_state` successfully. For an
existing file, Tau verifies that exact file and fetches its active tree path before
publishing the tab. State/tree checks each have a 30-second deadline; they never
submit a model prompt. Startup failures clean up the child before responding.
`DELETE /api/live-sessions/:id` likewise waits for actual child exit, using SIGTERM
and then SIGKILL if needed. Concurrent resumes wait for deletion to finish.

Lifecycle failures return `{error, sessionId, childStopped}`. `childStopped: true`
(HTTP 400) means the failed startup's child is confirmed stopped; `false` (HTTP 503)
means exit is unconfirmed. An uncertain child remains tracked and blocks another
resume until it exits or an explicit DELETE confirms cleanup.

Resume validation failures (HTTP 400) also return `childStopped: true` when the
request identifies a file, no spawn was attempted, and Tau knows of no existing,
starting, pending-resume, closing, or terminal-registry owner for that path.
Otherwise validation returns `childStopped: false`. Missing/invalid `filePath`
types, malformed request bodies, unexpected errors, and ownership conflicts
(HTTP 409) omit `childStopped`. An ownership
conflict remains unsafe even if this request never spawned a child. A transport
failure or ordinary error without `childStopped` is not evidence of child exit.
These are per-request guarantees using Tau's known state and advisory registry,
not a lock against independently launched Pi processes. Never use `force` as an
automatic transfer mechanism.

Tau has no terminal, so it hosts Pi sessions only: `panel-start` and other shell
work stay on a terminal host.

## How it works

```
┌─────────────┐     ┌──────────────────────────┐     ┌───────────────────────────┐
│  Browser    │◄───►│  Tau Web Server          │◄───►│  pi --mode rpc            │
│  (Tau UI)   │     │  HTTP + WebSocket +      │     │  child session 1          │
│             │     │  LiveSessionManager      │     ├───────────────────────────┤
│             │     │  (Node.js)               │     │  pi --mode rpc            │
│             │     │                          │     │  child session 2          │
│             │     │                          │     ├───────────────────────────┤
│             │     │                          │     │  pi --mode rpc            │
│             │     │                          │     │  child session (N)        │
└─────────────┘     └──────────────────────────┘     └───────────────────────────┘
```

The browser connects to Tau Web Server over WebSocket (and HTTP for history and API calls). Tau manages a pool of `PiRpcSession` instances, each of which spawns a `pi --mode rpc` subprocess. Communication with Pi is over JSON line-delimited RPC via stdin/stdout. Closing an in-page Tau tab sends a DELETE request that terminates the corresponding Pi child. Shutting down Tau terminates all managed children.

## Development

### Prerequisites

- [Pi](https://github.com/earendil-works/pi) must be installed (`pi` on `PATH`)
- Node.js and npm
- A compiled [pi-sound](../pi-sound) checkout next to this one (`npm ci --ignore-scripts && npm run compile` there); Tau depends on it as `file:../pi-sound`

### Setup

```bash
git clone https://github.com/milanglacier/pi-tau-web-server.git
cd pi-tau-web-server
npm install
npm run build
npm link
pi-tau-web-server --projects-dir ~/code
```

The project is written in TypeScript, with separate `tsconfig.json` files:

| Config                 |                                       Targets |
| ---------------------- | --------------------------------------------: |
| `tsconfig.server.json` |     Server-side code (`src/server/` → `bin/`) |
| `tsconfig.public.json` | Browser-side code (`src/public/` → `public/`) |
| `tsconfig.test.json`   |                          Test files (`test/`) |

Compiled JS is not committed to git (see `.gitignore`). Always run `npm run build` (or `tsc -p <config>`) after editing TypeScript source.

Edit `public/` files and refresh the browser. Restart `pi-tau-web-server` after changing server code in `src/server/`.

### Tests

```bash
npm test
```

The test suite uses Node.js built-in `node --test` and covers session-file path validation, the `PiRpcSession` state machine, `LiveSessionManager`, the `/api/rpc` shim, HTTP + WebSocket server surface (including same-origin/CORS hardening and malformed-URL hardening), and WebSocket auth gating.

Dictation: `node --test test/voice.test.ts test/voice-route.test.ts test/e2e/voice-input.e2e.ts`
uses fake speech backends and Chromium's fake microphone. Backend and settings
tests, including the opt-in live Claude check, live in pi-sound.

Each test file points `PI_CODING_AGENT_DIR` at an isolated temp tree so real Pi settings and sessions are never touched. The `LiveSessionManager` tests replace the real `spawn` with a test stub.

### Project structure

```
├── bin/            # Compiled server-side JS
├── public/         # Compiled browser-side JS, HTML, CSS, icons
├── src/
│   ├── server/     # Server TypeScript source
│   │   ├── server-main.ts   # HTTP server, WebSocket, API routes
│   │   ├── sessions.ts      # PiRpcSession + LiveSessionManager
│   │   ├── model-utils.ts   # Model parsing and formatting
│   │   ├── config.ts        # Settings, paths, CLI args
│   │   ├── voice.ts         # Dictation socket (backends from pi-sound)
│   │   └── types.ts         # Shared type definitions
│   └── public/     # Browser TypeScript source
│       ├── app.ts, app-main.ts, state.ts, themes.ts, ...
│       └── websocket-client.ts
├── test/           # Node.js test files
├── docs/           # Screenshots and documentation
└── extras/         # Extra utilities
```

## License

MIT
