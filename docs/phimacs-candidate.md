# Private Phimacs candidate inputs

This candidate is based on upstream
`c1619a96353924e90f001b4745fc967e5008c336` and preserves the fork features recorded
at `8c8516d7f5640893a726f2f48177cf3ec51c88c0`. It is not published or installed into
an existing service. Candidate source, artifacts and branches remain private until
the full integration matrix and explicit publication approval.

## Reproducible package graph

`vendor/manifest.json` records compiled pimux, orchestration and generic sound
archives, source provenance, hashes and licenses. Every internal dependency is a
local archive with a locked integrity, never a registry-name fallback or sibling
checkout. Orchestration's exact pimux requirement shares Tau's local archive;
its Pi SDK peers share the existing locked host without additional root packages.
Package contents retain those archives, compiled JavaScript, optional
Pi extension source, browser fonts/highlighting and original notices. The npm pack
is an input to the coordinated release graph, not a standalone offline installer:
file dependencies require the included vendor directory to be extracted before
hydration. The complete release hydrates these locked inputs and ships the whole
runtime tree; it must not advertise a bare npm-global install of this input pack.

The pimux archive includes the cross-process claim transaction, the bootstrap
that waits for durable child ownership before Pi execution, and contextual input
admission. Every mutating RPC command carries the exact `pimuxContext` captured
from an authoritative snapshot after its matching live boundary. The router
rejects stale, missing or unknown contexts instead of substituting the current
file or branch. Sound is rebuilt from its pinned source and retains the same
verified archive bytes when those inputs are unchanged.

The pimux and orchestration archives are compiled from the retained
`phimacs-source-working-*.tgz` snapshot. `sourceArchiveSha256` identifies those
exact dirty source bytes. `sourceBaseRevision` identifies only their Git base;
`sourceDirty:true` means they do not correspond exactly to that commit. They
therefore have no `sourceRevision`. Sound retains its committed source revision
and unchanged archive, including its MIT license and Apache-2.0 sound notices.

The vendor archives and retained snapshot select the reviewed stable root tree,
including its PTY and deck integration. They remain dirty-tree development inputs;
final committed-source archival and acquisition pins are still pending.

To rebuild the dirty inputs, extract their source snapshot into an empty isolated
directory, run `npm ci --ignore-scripts`, then run `npm run compile --workspace
@phimacs/pimux` and `npm run compile --workspace pi-orchestration`. Run
`npm pack --ignore-scripts` from each compiled package directory. Preserve the
licenses, hash the resulting archives and record their exact source snapshot in
`vendor/manifest.json`. Dependency paths must be relative `file:vendor/...tgz`
specifiers, never temporary build paths. Refresh the existing lock with
`npm install --package-lock-only --ignore-scripts --offline --no-audit` and review
all existing registry versions, URLs and integrity hashes for unintended changes.

Use `npm ci --ignore-scripts`, then explicit TypeScript compilation and the two
asset-copy scripts. There is no install-time `prepare` hook. The runtime Pi SDK is
exactly 1.4.0; pimux, orchestration and sound share that physical host package.
`node --test test/vendor-inputs.test.ts` checks archive and source hashes, retained
notices, packed public task APIs, installed bin files and common SDK resolution.
The explicit native `test/e2e/worker-close-native.e2e.ts` lane checks final parent
cleanup through a real worker using these installed packages.

Configuration uses `--pi-command` / `TAU_PI_COMMAND` for one absolute supported
release Pi; the default is the installed SDK entry. `PHIMACS_PI_VERSION` and
`PHIMACS_PI_SHA256` validate the release selection. `PI_CODING_AGENT_DIR` owns user
state. `PIMUX_DIR` changes discovery, not the production claim root. Tests use
marked synthetic claim namespaces that cannot authorize production session paths.

## Preserved behavior and acceptance

The isolated rebase reconciles upstream ordered and uncertain-delivery queues,
dialog/Abort acknowledgements, error/retry preservation, nested tool rendering,
completion guards and session search/list controls with the fork's grouped
activity, lazy project lists, TLS/authentication and orchestration features.

Runtime tests cover both frontend creation directions, zero-client survival,
server shutdown/restart, reconnect, authoritative snapshots, first-answer dialogs,
explicit stop receipts, native-owner/force refusal, retained old-file claims,
worker parent identity, exact-host refusal, lease-protected file operations and
full-tree HTML export from the owning selected leaf. Browser tests cover deferred
follow success/failure, repeated selection, expanded non-favourite refresh,
out-of-order responses, draft/image/queue quarantine and acknowledged global
queue recovery. Public sound tests cover asynchronous cancellation and disabled
configuration without native credential or device discovery. Faux providers and
synthetic backends only; these are not paid-provider or live-deployment tests.

## External release gates

- Pi 1.4.0 has unguarded internal storage paths. Managed claims protect cooperating
  launches and lease-mediated operations, not arbitrary raw Pi/editor I/O. No Pi
  fork is part of this candidate.
- The official Pi 1.4.0 distribution contains bundled vulnerable dependencies.
  External npm overrides do not patch embedded code. A reviewed owning fixed host
  artifact is required before the complete Phimacs release can be accepted.
- Tau/upstream declare MIT without a tracked license grant. Preserve attribution
  and obtain clarification before public redistribution; private work is not a
  blanket relicensing decision.
- Final archival remains pending. Commit the reviewed root and Tau source changes,
  rebuild and retain their corresponding-source archives, then update the root's
  committed fork/source acquisition pins. Dirty snapshot hashes are reproducible
  development inputs, not committed revision pins or public acquisition evidence.
  The root release pack already replaces these internal vendor edges through its
  coordinated package map; no release pin can be updated before committed hashes
  exist. No public push or service change follows from these tests.
