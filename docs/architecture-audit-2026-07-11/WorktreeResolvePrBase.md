# Architecture Audit — `worktree_resolve_pr_base` (PR → git-resolvable base ref)

**Date:** 2026-07-11
**Scope:** New backend command `git::pr_base::worktree_resolve_pr_base` + its
cross-layer wire contract to the frontend (`resolvePrWorktreeBase`,
`WorktreeLaunchSource.resolvedBaseRef`, `getWorktreeFields`).
**Auditor:** worktree PR-base resolution session.

This change adds a Rust command + TS wiring. Per the routing rule, the layers
that the change clearly touches are audited; layers with no surface are marked
**skipped** with a one-line reason.

---

## Layer 1 — Compilation Correctness

- `cargo test -p git pr_base` → compiles, **13/13 tests pass**.
- `cargo check -p org2` (full app crate, exercises `generate_handler!` registration
  of the new command) → **Finished, no errors**.
- `pnpm typecheck` (`tsc --noEmit`) → **exit 0**.
- No new clippy-visible patterns introduced (subprocess + thread drain mirror the
  existing `bundle.rs` idiom). **Pass.**

## Layer 2 — Dead Code & Structural Deduplication

- Traced from the business entry point: FE `WorktreeSourceModal.handleConfirm`
  → `resolvePrWorktreeBase` (`invoke("worktree_resolve_pr_base")`) → Rust
  `worktree_resolve_pr_base` → `resolve_pr_base` → `resolve_pr_base_with` (pure)
  → real git runner. Every new symbol is on a live path.
- `resolve_pr_base_with` is generic over a runner so the pure logic is shared by
  both the real command **and** the unit tests — no parallel test-only reimplementation.
- Did **not** duplicate `git worktree` / fetch logic that already exists: the
  resolver only fetches + rev-parses; worktree creation stays in the existing
  `create_session_worktree` path (base ref forwarded via the existing `branch`
  field). **Pass.**

## Layer 3 — Naming Consistency

- Command name `worktree_resolve_pr_base` matches the `git::*` snake_case Tauri
  convention (`get_local_head_sha`, `merge_cloud_ref`); FE wrapper
  `resolvePrWorktreeBase` matches the FE camelCase convention.
- `PrBaseResolution` / `PrBaseSource` serialize camelCase (`baseRef`, `headSha`,
  `branchNameOverride`, `compareBaseRef`, `source: "branch"|"pullRef"`) and the TS
  `interface PrBaseResolution` mirrors it field-for-field. **Pass.**

## Layer 4 — Semantic Overloading

- `branch`: the launch payload field `SessionLaunchParams.branch` already means
  "isolate base commit-ish" for worktree launches (documented in
  `getWorktreeFields`). This change keeps that meaning — `resolvedBaseRef` (a SHA)
  is fed through the same field. No new overload.
- `baseBranch` vs `baseRef` vs `resolvedBaseRef` vs `compareBaseRef` are
  deliberately distinct: `baseBranch` = human label / PR head branch name;
  `resolvedBaseRef`/`baseRef` = concrete fetched head SHA (git-usable);
  `compareBaseRef` = the diff-against ref (`refs/remotes/<remote>/<base>`). Each
  documented at its definition. **Pass** (checked to avoid re-overloading "base").

## Layer 5 — Default Branch Analysis

- `normalize_remote`: `None`/blank → `origin`. Correct for all callers — the FE
  only ever lists PRs from the `origin` GitHub remote, so `origin` is the right
  default; an explicit remote is still honored.
- `resolve_pr_base_with` fallback branch: branch-fetch failure only falls through
  to `refs/pull/<n>/head` when `is_missing_remote_ref_error` matches; **any other
  failure (auth/network) surfaces** rather than silently hitting the fallback
  (test `surfaces_non_missing_ref_fetch_failure_without_fallback`). This is the
  key default-safety property. **Pass.**

## Layer 8 — Wire Protocol & Serialization Audit

- Inspected the actual serialized contract, not just the structs:
  - **Rust → FE (result):** `#[serde(rename_all = "camelCase")]` on
    `PrBaseResolution` + `PrBaseSource`. Enum serializes as `"branch"` / `"pullRef"`
    (unit variants → plain strings), matching the TS `type PrBaseSource =
"branch" | "pullRef"`. `Option<String>` → `string | null` (matches TS).
  - **FE → Rust (args):** command uses `rename_all = "camelCase"`, so FE passes
    `repoPath`, `prNumber`, `remote`, `headBranch`, `baseBranch`. Optional args are
    sent as `?? null`, which Tauri maps to `Option::None`. Verified against the
    `#[tauri::command(rename_all = "camelCase")]` signature.
- No schema generator involved (no `schemars`); payload is a small fixed struct —
  no bloat risk. **Pass.**

## Layer 9 — Init Parity Across Entry Points

- Single production entry point (`worktree_resolve_pr_base` Tauri command); the
  unit tests drive the same pure core (`resolve_pr_base_with`) through a mock
  runner, so test and production share identical branch/fallback logic. The only
  step the test path omits is real subprocess execution (`run_git_capture_with_timeout`),
  which is I/O, not business logic — an intentional, documented seam. **Pass.**

## Layer 10 — Resolver Symmetry

- `resolve_pr_base_with` resolves one primary output (`base_ref` = head SHA) via a
  two-tier source chain: (1) `fetch <remote> <head_branch>`, (2) fallback
  `fetch <remote> refs/pull/<n>/head`. Both tiers converge on the _same_
  `rev_parse_fetch_head` reader — symmetric extraction, no field skips a source.
- `branch_name_override` is populated on both tiers when a head branch is known
  (test asserts fork PRs still surface the head branch as a label). `compare_base_ref`
  is derived identically regardless of which fetch tier won. No asymmetry. **Pass.**

## Layers skipped (no surface)

- **Layer 6 (cross-domain leakage):** the new module is a self-contained git leaf;
  no shared/core module gained a PR-specific field.
- **Layer 7 (new-dev confusion):** covered implicitly by Layer 3/4 naming review;
  all new public items carry doc comments explaining intent + the orca alignment.

---

## Summary

- **All audited layers pass** (1,2,3,4,5,8,9,10); 6 & 7 skipped with reason.
- Key safety properties verified by tests: fork fallback only on missing-ref,
  auth/network errors surface, empty rev-parse errors, blank head branch → pull ref.
- Wire contract confirmed symmetric on both directions (camelCase, enum strings,
  `Option`↔`null`).
- No dead code, no duplication of existing worktree/fetch logic, no new semantic
  overload of `branch` / `base`.
