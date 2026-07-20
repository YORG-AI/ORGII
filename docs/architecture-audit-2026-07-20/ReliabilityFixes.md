# Architecture Audit — Reliability Fixes

**Scope:** Warp imported-history cache, session-replay diff offsets, Codex OAuth repair routing, and editor-canvas token consumers
**Date:** 2026-07-20
**Auditor:** Codex

## 10-layer audit

### Layer 1 — Compilation correctness

- Full TypeScript typecheck passes.
- Targeted ESLint passes for every changed TypeScript/TSX file.
- Forty-three targeted frontend tests and six Warp importer tests pass.
- `orgtrack_core` clippy reports only the unchanged `qoder/log_enrichment.rs:128` baseline `type_complexity` diagnostic; the changed Warp module is clean.

### Layer 2 — Dead code and structural deduplication

- Diff start-line evidence is owned by `src/util/diff/startLines.ts`; both replay pipelines consume it.
- Five editor-canvas class literals now consume the existing workstation token.
- Warp cache synchronization decodes task protobufs only for records whose per-conversation signature changed.

### Layer 3 — Naming consistency

- `hasLoaded` means the initial local key-store request has settled.
- `buildCodexReauthPath` and `parseCodexReauthIntent` form an explicit route codec.
- Warp `signature` contains only per-conversation evidence rather than database-global metadata.

### Layer 4 — Semantic overloading

| Term               | Meaning                                                                                | Verdict                                                   |
| ------------------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| reauth account     | Existing Codex account whose rotating OAuth credentials must be replaced               | Keep; distinct from adding an unrelated account.          |
| source signature   | Per-conversation metadata sufficient to decide whether transcript decoding is required | Keep; no longer overloaded with whole-database WAL state. |
| trusted start line | Offset backed by an ordinary edit, unified hunk, or concrete result diff               | Keep; shared predicate documents the contract.            |

### Layer 5 — Default branch analysis

- Ordinary Key Vault add flows are unchanged when `reauth=codex` is absent.
- Missing diff events return `false`, avoiding placeholder line numbers.
- An unavailable Warp database still clears the imported source cache through the existing empty-sync path.

### Layer 6 — Cross-domain leakage

- URL encoding remains in `config/mainAppPaths`; the chat error card only invokes the public builder.
- Key-store readiness remains in key-vault hooks; the page does not infer readiness from array length.
- Worker/database concerns do not leak into UI components.

### Layer 7 — New-developer confusion test

- The reauthentication route, return-state key, and auto-start intent are named at their ownership boundary.
- Comments explain why Codex errors require reconnect rather than retry.
- The Warp signature method makes incremental-cache evidence reviewable beside the record definition.

### Layer 8 — Wire protocol and serialization

- Reauth intent is URL-serializable and route-tested; return navigation accepts only `/orgii/app` paths.
- No Rust/TypeScript wire type changed.
- Warp cache columns retain the existing `ImportedHistoryRecordSignature` contract.

### Layer 9 — Init parity

| Entry point          | Account readiness                                 | OAuth callback                            | Return navigation       |
| -------------------- | ------------------------------------------------- | ----------------------------------------- | ----------------------- |
| Normal Key Vault add | Existing behavior                                 | Existing behavior                         | Models page             |
| Codex error repair   | Waits for initial key load before mounting wizard | Desktop callback in Tauri dev and release | Original in-app session |
| Web OAuth            | Existing behavior                                 | HTTP callback                             | Existing behavior       |

### Layer 10 — Resolver symmetry

- Reauth resolves an explicit account id first, then the sole Codex account fallback; the same resolved id is excluded from duplicate-name validation and used for saving.
- Warp signature creation and cache-input creation call the same `record.signature` method.

## Systematic sweep

- Checked all `shouldTrustDiffStartLines` definitions and consumers; one implementation remains.
- Checked exact `bg-[var(--cm-editor-background)]` TSX occurrences; all five use the shared token.
- Checked all 13 `common` locale files; `errors.*` completeness is zero missing keys.
