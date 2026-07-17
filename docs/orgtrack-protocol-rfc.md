# Orgtrack Protocol and Collector Extraction RFC

Status: Phase 1 implemented on `codex/session-provenance`
Protocol contract: `src-tauri/crates/orgtrack-protocol`
Current host integration: ORG2 / `orgtrack_core`

## Decision

Orgtrack will be extracted as a protocol, vendor adapters, a fail-open
collector, pluggable stores, and a conformance suite. Git submodule support is
a distribution choice for ORG2; it is not the protocol itself.

The independent boundary must remain usable from a desktop app, a local CLI,
a CI job, and a cloud container. Therefore it cannot depend on Tauri, ORG2 UI
types, ORG2's shared database initializer, or a particular host filesystem
layout.

```text
Claude / Codex / Cursor / ORG2
              |
      vendor or native adapter
              |
 ResourceInteractionEnvelope v1
              |
     fail-open collector/sidecar
       /          |           \
 SQLite        NDJSON       HTTP/Postgres
       \          |           /
       query API / ORG2 My Station
```

## Acceptance criteria

- One canonical resource-interaction type definition is used by production
  hook, native-ingestion, store, query, and UI paths.
- The protocol crate has no filesystem, database, Tauri, or vendor SDK
  dependency.
- A checked-in JSON Schema and golden fixture expose the exact wire shape.
- Unknown wire fields are rejected; prompts, commands, output, file contents,
  diffs, identities, and deployment paths cannot silently cross the boundary.
- Original source locations and destination store locations are configured
  separately and are never event fields.
- A collector failure never blocks the agent tool call.
- Replayed events are idempotent.
- Claude Code, Codex, Cursor, and ORG2 native paths pass the same conformance
  suite before the independent package replaces the in-tree implementation.

## Protocol boundary

`orgtrack_protocol` owns only stable, privacy-bounded metadata contracts:

- `ResourceInteractionEnvelopeV1`: producer/adapter-to-collector wire event;
- `ResourceInteractionRecord`: canonical immutable stored fact;
- `FileResourceRecord`: typed file projection of a generic resource;
- action, outcome, capture method, and attribution precision enums;
- version validation, JSON Schema, and golden fixtures.

The v1 envelope deliberately does not contain source database paths, collector
database paths, raw vendor payloads, prompts, messages, commands, tool output,
file contents, or diffs. `cwd` remains an event path-resolution base; a
collector may normalize or hash it before remote export according to policy.

The current ORG2 `orgtrack_core::canonical` module re-exports the protocol
types. This is a facade over one definition, not a second compatibility model.

## Original data paths: two distinct locator classes

“Original DB path” must not be one ambiguous field. There are two unrelated
directions and each has a separate owner.

### SourceLocator (read-only input)

A `SourceLocator` tells an importer where a vendor's original history lives.
It is local deployment configuration and may refer to a directory, SQLite
file, NDJSON stream, or read-only HTTP endpoint.

Current macOS defaults include:

| Source      | Locator kind     | Current default/candidates                                                                         |
| ----------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| Claude Code | transcript roots | `~/.claude/projects`, plus Claude application-support candidates                                   |
| Codex       | transcript roots | `~/.codex/sessions`, plus Codex application-support candidates                                     |
| Cursor      | SQLite files     | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` and `conversation-search.db` |
| ORG2 native | live producer    | no upstream database scan is required                                                              |

These inputs are always opened read-only. The manifest assigns a stable
`sourceLocatorId`; event and cache identity must not depend on the absolute
host path.

### StoreLocator (normalized output)

A `StoreLocator` tells the collector where normalized Orgtrack records live.
ORG2 currently uses the broad shared database `~/.orgii/sessions.db`. A
standalone collector should default to its own mounted path, for example
`/data/orgtrack.db`, unless the ORG2 host explicitly selects the shared-store
adapter.

The manifest assigns a stable `storeId`. An absolute `displayPath` may be
shown by local diagnostics, but has `disclosure: local_only` and is not sent to
a remote collector by default.

### Proposed deployment manifest

```yaml
apiVersion: orgtrack.dev/v1alpha1
collector:
  id: workstation-vince
  spool: /data/spool
  failOpen: true

sources:
  - id: claude-local
    adapter: claude_code
    locators:
      - kind: directory
        path: /sources/claude/projects
        access: read_only
  - id: codex-local
    adapter: codex
    locators:
      - kind: directory
        path: /sources/codex/sessions
        access: read_only
  - id: cursor-local
    adapter: cursor
    locators:
      - kind: sqlite
        path: /sources/cursor/state.vscdb
        access: read_only

stores:
  - id: orgtrack-primary
    driver: sqlite
    path: /data/orgtrack.db
    disclosure: local_only

export:
  pathMode: repo_relative
  includeDeploymentPaths: false
```

The paths above are container paths after volume mapping, not host paths in
events. A container deployment mounts vendor sources read-only and the
collector data directory read-write.

## Package split

Phase 1 keeps the package in-tree, but the protocol directory is already a
self-contained Cargo package. Its manifest explicitly includes source,
schemas, fixtures, README, and conformance tests; it has no workspace-relative
code dependency; `cargo package --list` succeeds; and a boundary test rejects
Tauri, SQLite, ORG2-host, and vendor-adapter references. Moving it to a new
repository later is therefore a source-preserving directory extraction plus a
path-dependency update, not a protocol redesign.

The independent repository should converge on:

```text
orgtrack/
  crates/protocol/       # stable types, schema, fixtures
  crates/adapters/       # Claude, Codex, Cursor, native adapter SDK
  crates/collector/      # spool, batching, retry, idempotency, diagnostics
  crates/store/          # traits plus SQLite/NDJSON/HTTP implementations
  installers/            # merge-safe user hook installers
  conformance/           # vendor fixtures and end-to-end fake collector
  schemas/               # wire and deployment schemas
  container/             # minimal collector image and examples
```

ORG2 may consume this repository as a pinned submodule initially. The same
revision should also build publishable Rust crates, a CLI binary, a container
image, JSON Schemas, and generated language bindings. This prevents Git
submodule mechanics from becoming the only integration route.

## Extraction phases

1. **Protocol contract (current):** move the canonical resource-interaction
   types into the dependency-free `orgtrack_protocol` crate; wire production
   paths to that single definition; check in schema, fixtures, and privacy
   conformance tests.
2. **Adapter boundary:** move vendor payload normalization into adapter crates;
   replace hardcoded home-directory discovery with injected `SourceLocator`
   lists while preserving current defaults in the ORG2 host.
3. **Collector boundary:** extract spool, bounded drain, idempotency, retry,
   retention, and `doctor` diagnostics into a standalone binary. Define the
   deployment manifest schema and `Store` trait at the same time so neither is
   aspirational dead code.
4. **Independent repository:** preserve history into a new repository, pin it
   in ORG2, and run the conformance suite against both the path dependency and
   submodule checkout before removing the in-tree source.
5. **Cloud container:** verify read-only source mounts, writable store/spool,
   disconnect/retry behavior, path-redaction policy, and all four producers in
   a real container E2E.

Creating a remote repository, choosing public/private visibility, and pushing
history are intentionally outside Phase 1; those are external state changes
that require an explicit repository destination.

## User customization boundary

Safe, stable customization belongs in collector policy: source enablement,
workspace/repository scope, action filters, plaintext/relative/hashed path
mode, retention, destination, export, and per-source locator overrides.

Users should not be able to redefine required envelope fields or insert
arbitrary scripts into managed hook entries. Installers preserve unrelated
user hooks and manage only entries bearing the Orgtrack marker.
