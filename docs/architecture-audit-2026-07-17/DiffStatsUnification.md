# Diff Stats Unification Architecture Audit

**Date:** 2026-07-17  
**Scope:** Post-implementation review of unified-diff parsing, line-stat resolution, chat aggregation, shared types, and UI projections  
**Method:** `.orgii/skills/architecture-audit/SKILL.md`, all 10 layers

## Executive verdict

The current branch now has one production unified-diff parsing core under
`src/util/diff`, one canonical `LineDiffStats` value type, independent-field
fallback resolution, and truthful separation between aggregate and per-file
chat stats. The two hand-built diff-stat UI sites now reuse `DiffStatsBadge`.

The screenshot's repo-wide working-tree totals resource is intentionally not
implemented here: its hook and call sites exist on local `origin/develop` but
are absent from the checked-out `feat/i18n-locale-completeness` branch. Adding a
resource with no consumers would be dead architecture and would not deduplicate
the actual branch where the feature lives.

## Findings

| Priority | Line                                                                      | Element                             | Verdict          | Reason                                                                                                                              | Suggested change                                                                          |
| -------- | ------------------------------------------------------------------------- | ----------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| P1       | `src/util/diff/unifiedDiff.ts:46-173`                                     | Parser, projection, and stats count | unified          | One internal traversal now owns hunk coordinates, gap/blank-line policy, old/new reconstruction, and additions/deletions.           | Keep new surface policies explicit through `ParseUnifiedDiffOptions`.                     |
| P1       | `src/util/diff/unifiedDiff.ts:180-209`                                    | Hunk merge                          | fixed            | Later overlapping edits now win in edit order even when their start line is earlier; payload markers are retained.                  | Keep overlap-order regression tests.                                                      |
| P1       | `src/modules/WorkStation/shared/DiffFileSection/index.tsx:199-216`        | Header stats resolution             | fixed            | Supplied fields resolve independently; unified diff is exact fallback; only known added/deleted content uses full-content counting. | Do not reintroduce net content-length inference for modified files.                       |
| P2       | `src/engines/ChatPanel/InputArea/components/CompactFileChanges.tsx:55-58` | Visible summary                     | fixed            | Explicit aggregate totals remain aggregate truth; real per-file data is summed only when no aggregate is supplied.                  | Keep `FileChangeSummary` separate from rows.                                              |
| P2       | `src/engines/ChatPanel/ChatView.tsx:159-169`                              | Impact-derived rows                 | fixed            | Synthetic file rows no longer pretend the first file owns all line changes.                                                         | Populate per-file values only when the source provides a breakdown.                       |
| P2       | `src/engines/SessionCore/rendering/props/editExtractors.ts:164-175`       | Numeric precedence                  | fixed            | Nullish numeric selection preserves authoritative zero and full-write fallback now checks absence explicitly.                       | Keep conflicting-source test.                                                             |
| P2       | `src/features/CodeViewer/types.ts`; `useDiffLines.ts`                     | CodeViewer stats type               | fixed            | Hook imports the feature type, which aliases canonical `LineDiffStats`; duplicate declaration removed.                              | —                                                                                         |
| P2       | `origin/develop:useWorkingTreeDiffTotals`                                 | Repo-keyed shared fetch resource    | branch follow-up | The feature is absent from the current checkout, so an in-branch implementation cannot be connected or verified.                    | Land the repo-keyed resource on the branch that contains the hook and its four consumers. |
| P3       | CodeViewer/edit-event local reducers                                      | Small domain reducers               | keep with reason | Input representations and authority differ even though output uses the same value type.                                             | Share value types, not unrelated source semantics.                                        |

## Deleted duplication and dependency direction

```text
Before
  CodeBlock local parser
  SessionCore shared parser <- imported by WorkStation/MainApp
  SessionReplay local parser
  util parser used only by tests

After
  src/util/diff/unifiedDiff
    <- CodeBlock
    <- Chat DiffBlock
    <- SessionCore-adjacent callers
    <- WorkStation replay/diff sections
    <- MainApp playground
```

The migration removes the copied production loops and all production imports
of unified-diff parsing from `SessionCore/rendering/props`.

## Ten-layer audit coverage

| Layer                                 | Result                    | Notes                                                                                                                                       |
| ------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness            | baseline-only failure     | ESLint passes and targeted tests pass. Full typecheck reports only the pre-existing `ContextInfoButton.tsx:468` error.                      |
| 2. Dead code & structural duplication | pass                      | Definition/test-only util parser became canonical; three copied production parser bodies and the unused per-hunk parser were removed.       |
| 3. Naming consistency                 | pass                      | Canonical internal value is `LineDiffStats`; aggregate value is `FileChangeSummary`; boundary names remain adapted at their owners.         |
| 4. Semantic overloading               | pass with boundary caveat | Line stats and file-status counts remain separate. Existing external DTO field names are not renamed across wire boundaries.                |
| 5. Default branch analysis            | pass                      | Zero-valued authoritative stats use nullish precedence; missing fields resolve independently.                                               |
| 6. Cross-domain leakage               | pass                      | Neutral parsing is under `src/util/diff`; MainApp and WorkStation no longer import parsing from SessionCore.                                |
| 7. New-developer confusion            | pass                      | One parser core exposes named policy options; one value type describes additions/deletions.                                                 |
| 8. Wire protocol & serialization      | pass                      | No Tauri/HTTP schema or serialization changed; normalization remains after typed boundaries.                                                |
| 9. Init/entry-point parity            | pass for TS paths         | CodeBlock, DiffBlock, playground, and replay now call the same parser. Rust-vs-TS extraction parity remains an independent broader concern. |
| 10. Resolver symmetry                 | pass                      | Additions and deletions use identical independent precedence.                                                                               |

## Verification

| Check                 | Result                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------- |
| Related Vitest suites | Pass: 12 files / 263 tests                                                               |
| Targeted ESLint       | Pass                                                                                     |
| `git diff --check`    | Pass                                                                                     |
| `pnpm typecheck`      | Only pre-existing unrelated error at `ContextInfoButton.tsx:468`                         |
| Parser import sweep   | Zero production imports from SessionCore; no unused `parseUnifiedDiffToHunks` definition |
| Audited UI sweep      | Zero hand-built `+N/-N` renderers in the two identified sites                            |

## Follow-up on the screenshot branch

When the working-tree totals feature is brought into this branch (or this work
is rebased onto `origin/develop`), centralize it as one repo-keyed resource with
shared value, in-flight request, debounce, and repo-status listener. That work
must be verified with all four consumers mounted; it should not be represented
by an unused placeholder in this branch.
