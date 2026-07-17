# Orgtrack Protocol

This crate is the extraction boundary for Orgtrack's resource-interaction
metadata protocol. It is intentionally independent of ORG2, Tauri, SQLite,
filesystem discovery, and vendor hook formats.

## Contract boundary

The resource-interaction envelope contains only the identity and timing needed
to answer: which session interacted with which resource, how, when, and with
what attribution precision. The session-actor lifecycle envelope additionally
supports a local child-transcript locator so a host can open the exact
subagent transcript. Neither contract contains prompts, commands, tool output,
file contents, diffs, user identity, or local database locations.

Original vendor history paths and normalized-store paths are deployment
configuration, not event fields:

- `SourceLocator`: read-only roots such as Cursor `state.vscdb`, Claude project
  transcripts, or Codex session logs.
- `StoreLocator`: a collector destination such as ORG2's existing
  `~/.orgii/sessions.db` or a mounted container path like `/data/orgtrack.db`.

The lifecycle `transcriptPath` is explicitly local-only metadata. A collector
may persist it in its protected local store, but exporters must omit it from
repo-shareable bundles and cloud uploads by default. Cross-machine identity
uses configured source/store IDs and canonical session IDs rather than path
strings.

## Compatibility

- JSON schemas: `schemas/resource-interaction-envelope-v1.schema.json` and
  `schemas/session-actor-lifecycle-envelope-v1.schema.json`
- Golden fixtures: `fixtures/resource-interaction-envelope-v1.json` and
  `fixtures/session-actor-lifecycle-envelope-v1.json`
- Unknown envelope fields are rejected.
- Schema versions are explicit and independent from ORG2's `.orgtrack` export
  schema and collector configuration versions.

The current ORG2 integration re-exports these canonical protocol types from
`orgtrack_core::canonical`; there is only one definition and the production
hook/native/store paths compile against it.

## Extraction check

This directory is a complete Cargo package: source, schema, fixture, README,
and conformance tests are explicitly included in its manifest. It has one
normal dependency (`serde`) and a package-boundary test that rejects Tauri,
SQLite, ORG2 host, and vendor-adapter references. Before moving it to a new
repository, verify the exact portable file set with:

```bash
cargo package --manifest-path Cargo.toml --allow-dirty --list
```

No workspace-relative code dependency or generated ORG2 artifact is required.
The future standalone adapters/collector can depend on this package without
changing the v1 contract.

## Live vendor conformance

After real vendor hooks have written into an isolated inbox, validate their
exact wire output with:

```bash
ORGTRACK_LIVE_ENVELOPE_DIR=/path/to/inbox \
  cargo test -p orgtrack_protocol --test live_vendor_envelopes -- --ignored
```

The test requires Claude Code, Codex, and Cursor sources with both read and
write actions, accepts strict resource and actor-lifecycle envelopes, performs
exact round-trips, and checks that file-content sentinels did not enter either
contract.
