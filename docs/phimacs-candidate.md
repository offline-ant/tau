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

The pimux and orchestration archives are compiled from the committed Phimacs
revision recorded in `vendor/manifest.json`. Its complete Git source archive is
retained alongside the packs and verified by SHA-256. Unrelated working-tree
changes are excluded. Sound retains its existing committed source and archive,
including its MIT license and Apache-2.0 sound notices.

To reproduce the packs, extract the retained source archive, run
`npm ci --ignore-scripts`, compile the pimux and orchestration workspaces, then run
`npm pack --ignore-scripts` in each. The resulting archives reproduce byte-for-byte.
Vendor dependencies use relative `file:vendor/...tgz` paths with locked integrity;
no temporary build paths or dirty-source revision claims are retained.

Use `npm ci --ignore-scripts`, then explicit TypeScript compilation and the two
asset-copy scripts. There is no install-time `prepare` hook. The runtime Pi SDK is
exactly 1.5.0; pimux, orchestration and sound share that physical host package.
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

- Pi 1.5.0 has unguarded internal storage paths. Managed claims protect cooperating
  launches and lease-mediated operations, not arbitrary raw Pi/editor I/O. No Pi
  fork is part of this candidate.
- Pi 1.5.0 selects patched undici/minimatch dependencies. Actual bundled-host
  security acceptance remains required; external npm audit alone is not proof.
  The owning review is Phimacs's `docs/dependency-security.md`.
- Tau/upstream declare MIT without a tracked license grant. Preserve attribution
  and obtain clarification before public redistribution; private work is not a
  blanket relicensing decision.
- The complete release must use this candidate's committed source archive and
  matching root acquisition pins. The root pack replaces internal vendor edges
  through its coordinated package map. Final immutable-release acceptance remains
  separate from source tests; no public push or service change follows from them.
