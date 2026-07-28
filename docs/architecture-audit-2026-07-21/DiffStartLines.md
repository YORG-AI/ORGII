# Architecture Audit — Diff Start-Line Evidence

**Scope:** shared replay diff start-line evidence and its two construction pipelines
**Date:** 2026-07-21
**Auditor:** Codex

## 10-layer audit

### Layer 1 — Compilation correctness

- The split branch passes the scoped TypeScript pre-commit check.
- Twenty-one targeted Vitest tests pass across the shared helper, file converter, and replay section builder.

### Layer 2 — Dead code and structural deduplication

- `src/util/diff/startLines.ts` owns the only implementation of the evidence predicate.
- `fileConverter.ts` re-exports the helper because existing replay consumers import through that public boundary; both construction pipelines execute the shared implementation.

### Layer 3 — Naming consistency

- `shouldTrustDiffStartLines` is retained at all call sites and still describes the boolean contract.
- The removed private helpers have no remaining definitions.

### Layer 4 — Semantic overloading

| Term                | Meaning                                                                        | Verdict                                          |
| ------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ |
| trusted start lines | Line offsets backed by an ordinary edit, unified hunk, or concrete result diff | Keep; one shared predicate now defines the term. |

### Layer 5 — Default branch analysis

- Missing events return `false`.
- Events without patch text retain the existing ordinary-edit behavior and return `true`.
- Compact patch placeholders require either a unified hunk or a concrete result diff.

### Layer 6 — Cross-domain leakage

- The shared utility accepts a minimal evidence shape and does not import workstation or session-event modules.
- Replay-specific event types remain in their existing callers.

### Layer 7 — New-developer confusion test

- The helper comment states why the predicate exists.
- The public name and tests make the accepted evidence forms explicit.

### Layer 8 — Wire protocol and serialization

- No request, response, persisted record, or serialized event shape changes.
- The change only interprets existing in-memory event evidence.

### Layer 9 — Init parity

| Entry point                             | Shared predicate              |
| --------------------------------------- | ----------------------------- |
| Session replay file conversion          | `src/util/diff/startLines.ts` |
| Workstation replay section construction | `src/util/diff/startLines.ts` |

### Layer 10 — Resolver symmetry

- Both replay pipelines evaluate the same argument and result fallback chain through the shared helper.
- No multi-field resolver or database fallback chain is introduced.

## Systematic sweep

- Searched every `shouldTrustDiffStartLines` definition and consumer; one implementation remains.
- Targeted tests cover missing events, ordinary edits, unified hunks, compact placeholders, and result-backed diffs.
