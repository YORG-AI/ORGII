# Architecture Audit — Warp History Cache

**Scope:** per-conversation Warp cache signatures and changed-record decoding
**Date:** 2026-07-21
**Auditor:** Codex

## 10-layer audit

### Layer 1 — Compilation correctness

- `cargo check -p orgtrack_core` passes.
- `cargo clippy -p orgtrack_core --lib` reports only the unchanged `qoder/log_enrichment.rs` type-complexity warning; changed Warp code is clean.
- All six targeted Warp history tests pass.

### Layer 2 — Dead code and structural deduplication

- `WarpConversationRecord::signature` is the single constructor used by cache comparison and cache-input creation.
- Task protobufs are loaded and decoded only for records returned by `changed_records_from_conn`.

### Layer 3 — Naming consistency

- `task_last_modified_at` identifies per-conversation task freshness rather than database-global WAL state.
- `signature` matches the imported-history cache terminology used by sibling importers.

### Layer 4 — Semantic overloading

| Term      | Meaning                                                                     | Verdict                                                         |
| --------- | --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| signature | Per-conversation metadata sufficient to decide whether decoding is required | Keep; database-global sidecar state is no longer mixed into it. |

### Layer 5 — Default branch analysis

- Missing or malformed timestamps fall back to zero without hiding a changed fingerprint.
- Missing task aggregates retain explicit empty defaults.
- An unavailable Warp database continues through the existing empty-source synchronization path.

### Layer 6 — Cross-domain leakage

- Warp SQL and protobuf analysis remain inside the Warp source module.
- Generic changed-record and live-ID operations remain owned by imported-history cache helpers.

### Layer 7 — New-developer confusion test

- Signature construction is colocated with the queried record fields.
- The sync flow reads as discover records, compare signatures, decode changed records, then synchronize live IDs.

### Layer 8 — Wire protocol and serialization

- No external network payload changes.
- Persisted imported-history signature columns retain their existing contract and parser version.

### Layer 9 — Init parity

- Initial import and subsequent refresh use the same record query and signature constructor.
- Pre-summary Warp schemas remain covered by the compatibility test.

### Layer 10 — Resolver symmetry

- Cache comparison and cache-input creation call the same `record.signature(db_path)` method.
- Conversation and task modification timestamps participate in one symmetric maximum-freshness calculation.

## Systematic sweep

- Compared the Warp importer with sibling `changed_records_from_conn` consumers.
- Verified live-ID derivation remains independent of the changed-record subset so deletions still synchronize.
