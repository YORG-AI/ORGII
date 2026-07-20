# Diff Stats Logic Architecture Audit

**Date:** 2026-07-17  
**Scope:** Diff parsing, line-stat derivation, aggregation, fallback resolution, and working-tree total loading in `src/`; screenshot-specific status-bar logic compared against local `origin/develop` at `5be17525b`  
**Mode:** Audit only; no source code changed  
**Method:** `.orgii/skills/architecture-audit/SKILL.md`, all 10 layers

## Executive verdict

The concern is valid at the logic layer. UI rendering is already broadly consolidated into `DiffStatsBadge`, but the data below it is not equally consolidated.

The main issue is not a large number of repeated `sum()` calls. It is that the repository has **four old/new unified-diff reconstruction implementations** (three live, one definition/test-only), plus another hunk parser and several independent line-count loops. Their behavior is not governed by one policy: some preserve gaps between hunks, some do not; some treat an unprefixed blank line as context, one ignores it; and different surfaces own different parser types.

The screenshot's working-tree totals have the opposite problem: the hook is reused, but its state and request are not. `WorkStationStartPage` remains mounted while hidden, `TabBarPlusMenu` always mounts, and `EditorStatusBar` can mount alongside them. Each hook instance owns its own API request, debounce, listener, and cache entry, so the same repository can trigger two or three identical numstat requests on mount and on every status update.

### Priority summary

| Priority | Finding                                                                                                       | Impact                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| P1       | Three live unified-diff reconstruction implementations encode divergent policies                              | The same diff can produce different reconstructed content/start-line behavior across CodeBlock, SessionCore, and Session Replay |
| P1       | `DiffFileSection` resolves additions/deletions as an all-or-nothing pair and falls back to total-length delta | A single missing field discards the provided field; equal-length replacements can be displayed as `+0/-0`                       |
| P2       | `useWorkingTreeDiffTotals` shares code but not keyed state/in-flight work                                     | Hidden and visible WorkStation consumers can duplicate numstat requests and WebSocket-driven refreshes                          |
| P2       | Chat file-change aggregate data is redistributed onto the first synthetic file and then summed back up        | Aggregate truth is encoded as fake per-file truth, making the model misleading and fragile                                      |
| P2       | `DiffStats` and related names represent several incompatible field sets                                       | Imports and adapters require tribal knowledge; same-name types cannot safely substitute for one another                         |
| P3       | Small aggregation loops are repeated across domain-specific representations                                   | Some can share a value type/helper, but forcing every reducer behind one abstraction would hide meaningful source semantics     |

## Evidence-backed findings

| Priority | Line                                                                                                            | Element                                          | Verdict                               | Reason                                                                                                                                                                                                                                                                                                                        | Suggested change                                                                                                                                                                                                                    |
| -------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | `src/engines/ChatPanel/blocks/CodeBlock/diffParser.ts:37-105`                                                   | CodeBlock unified-diff parser                    | **unify**                             | Reconstructs old/new content, start lines, and inter-hunk gaps locally. The same loop exists in SessionCore and Session Replay.                                                                                                                                                                                               | Move the canonical parser to a neutral `src/util/diff/unifiedDiff.ts` module with explicit options and migrate this caller.                                                                                                         |
| P1       | `src/engines/SessionCore/rendering/props/extractorShared.ts:284-347`                                            | SessionCore `parseUnifiedDiffToOldNew`           | **move/unify**                        | This is currently the most capable implementation, but WorkStation and MainApp import it from an engine-internal module. It ignores raw blank lines while CodeBlock/FileConverter treat them as context.                                                                                                                      | Make this behavior the basis of the neutral parser; encode gap and blank-line policies as named options, then keep only one loop.                                                                                                   |
| P1       | `src/modules/WorkStation/CodeEditor/SessionReplay/converters/fileConverter.ts:43-108`                           | Session Replay `parseUnifiedDiffPayload`         | **delete after migration**            | Near-copy of CodeBlock's parser with a different return shape and nullable input behavior.                                                                                                                                                                                                                                    | Call the neutral parser and adapt the return shape at the boundary.                                                                                                                                                                 |
| P2       | `src/util/diff/index.ts:44-100`                                                                                 | Exported `parseUnifiedDiff`                      | **dead/replace**                      | No production caller was found; references are its definition/export and its own tests. It duplicates the live parsers but lacks start-line output.                                                                                                                                                                           | Migrate live parsers into the neutral utility, then delete this legacy implementation or replace it with a thin compatibility export only if a real caller remains.                                                                 |
| P1       | `src/modules/WorkStation/shared/DiffFileSection/index.tsx:198-208`                                              | Stats fallback                                   | **fix**                               | It trusts props only when both are defined. If one is missing, the other is discarded. The fallback compares total line counts, which cannot detect replacements: one removed line plus one added line has zero net length change. It also ignores `unifiedDiff`, despite that being sufficient to count exact `+`/`-` lines. | Resolve each field independently. Priority should be supplied stat -> canonical unified-diff count -> actual old/new diff result -> status-aware last resort. Never infer modified-file additions/deletions solely from net length. |
| P2       | `origin/develop:src/hooks/git/useWorkingTreeDiffTotals.ts:43-99`                                                | Working-tree totals hook                         | **centralize state**                  | Every mounted caller creates independent local state, fetch callback, debounce, and repo-status listener. The HTTP helper has no numstat in-flight cache.                                                                                                                                                                     | Back the hook with a repo-keyed atom/query/resource that shares one value, one in-flight promise, and one status listener per repo.                                                                                                 |
| P2       | `origin/develop:src/modules/WorkStation/AppShell/AppShellContent.tsx:146-160`                                   | Hidden StartPage mount                           | **keep UI mount; fix data ownership** | `WorkStationStartPage` stays mounted under `display:none`, so it continues fetching totals even when not visible. `TabBarPlusMenu` is also always mounted and the editor status bar may be present.                                                                                                                           | Do not couple fetching to each presentation mount; read a shared resource from all three surfaces.                                                                                                                                  |
| P2       | `origin/develop:src/engines/ChatPanel/ChatView.tsx:160-195`                                                     | `impactFileChanges`                              | **fix model**                         | Aggregate additions/deletions are assigned to the first file solely because `CompactFileChanges` later ignores `totalAdditions/totalDeletions` and re-sums per-file rows. The first file therefore carries fabricated stats.                                                                                                  | Represent `{ count, additions, deletions }` explicitly. Use per-file rows only when per-file data is truly available; otherwise consume aggregate fields directly.                                                                  |
| P2       | `src/engines/ChatPanel/InputArea/components/CompactFileChanges.tsx:21-70`                                       | Visible stats projection                         | **unify type/source**                 | `FileChangeVisibleStats` duplicates `FileChangeStats`, and the component always reduces rows even when its input already contains aggregate totals.                                                                                                                                                                           | Introduce one canonical `LineDiffStats` plus a clearly named `FileChangeSummary`; accept an aggregate summary without redistributing it to rows.                                                                                    |
| P2       | `src/features/CodeViewer/types.ts:69-72`; `src/features/CodeViewer/useDiffLines.ts:23-26`                       | Identical `DiffStats` definitions in one feature | **fix**                               | Exact duplicate shape inside CodeViewer.                                                                                                                                                                                                                                                                                      | Import the type from `types.ts`; do not redeclare it in the hook.                                                                                                                                                                   |
| P2       | `src/engines/SessionCore/rendering/props/editExtractors.ts:160-168`                                             | Numeric fallback via `                           |                                       | `                                                                                                                                                                                                                                                                                                                             | **make policy explicit**                                                                                                                                                                                                            | Zero is treated as missing when choosing between `successData` and `result`. Elsewhere zero is sometimes authoritative and sometimes a placeholder that triggers recomputation. The precedence rule is hidden in truthiness. | Use a named resolver that documents whether zero is valid for each source; prefer nullish selection when the higher-priority source is authoritative. Add conflicting-source tests. |
| P3       | `src/features/CodeViewer/useDiffLines.ts:94-103`; `src/features/CodeViewer/hooks/useModernSplitDiff.ts:122-131` | Line-type counters                               | **keep with reason**                  | Both count additions/deletions, but their input representations differ (`DiffLine` versus paired `AlignedLine`). The loops are short and colocated with their representation.                                                                                                                                                 | Share the output type and test fixtures; only extract a generic counter if a third caller uses the same representation.                                                                                                             |
| P3       | `src/engines/ChatPanel/ChatItems/EditActivityGroup/index.tsx:57-85`; `CompactFileChanges.tsx:60-69`             | Domain aggregation reducers                      | **keep with reason**                  | One sums edit events after extraction; the other sums authoritative per-file rows. Their source semantics differ even though the accumulator shape matches.                                                                                                                                                                   | Share the value type and zero constant, not necessarily the reducers.                                                                                                                                                               |

## Call-chain trace

### Screenshot working-tree totals (`origin/develop`)

```text
EditorStatusBar
  -> useEditorStatusBarGit
  -> useWorkingTreeDiffTotals(repoId, repoPath)
  -> getGitDiffNumstatCombined(include_untracked=true)

TabBarPlusMenu (always mounted)
  -> useWorkingTreeDiffTotals(same repo)
  -> same API request + independent listener/debounce/state

WorkStationStartPage (mounted even when display:none)
  -> useWorkingTreeDiffTotals(same repo)
  -> same API request + independent listener/debounce/state

FocusedChatWorkstationRail (when focused-chat layout is active)
  -> useWorkingTreeDiffTotals(same repo)
  -> another independent instance
```

The hook implementation is reused at four call sites, but it is not a shared resource. Reuse at the function level therefore does not deduplicate work.

### Unified-diff rendering paths

```text
Chat CodeBlock
  -> CodeBlock/diffParser.parseUnifiedDiff          (local parser)

Chat DiffBlock / Agent Station Diff / DevTools
  -> SessionCore.parseUnifiedDiffToOldNew           (engine-owned parser)

CodeEditor Session Replay
  -> fileConverter.parseUnifiedDiffPayload          (local parser)

src/util/diff.parseUnifiedDiff
  -> no production caller found                     (definition + tests only)
```

## Ten-layer audit coverage

| Layer                                 | Result                                 | Notes                                                                                                                                                                                                 |
| ------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 1. Compilation correctness            | **Baseline fail, targeted tests pass** | 68 targeted tests pass. `pnpm typecheck` fails at pre-existing `ContextInfoButton.tsx:468` (`string                                                                                                   | undefined`to`string`), unrelated to this audit. |
| 2. Dead code & structural duplication | **Fail**                               | One parser is definition/test-only; three production parsers repeat the same reconstruction loop; identical CodeViewer stats types are redeclared.                                                    |
| 3. Naming consistency                 | **Fail**                               | `DiffStats` names incompatible DTOs/value objects; additions/insertions and linesAdded/lines_added vary by boundary without one canonical internal name.                                              |
| 4. Semantic overloading               | **Fail**                               | “stats” can mean line counts, file-status counts, hunk counts, or aggregate working-tree totals. `FileChangesResult.stats` is file-status counts while `totalAdditions` is line counts.               |
| 5. Default branch analysis            | **Fail**                               | Truthiness-based numeric fallback treats zero as missing; `DiffFileSection`'s all-or-nothing fallback silently discards partial authoritative data.                                                   |
| 6. Cross-domain leakage               | **Fail**                               | Shared diff parsing lives under SessionCore and is imported by WorkStation and MainApp. The parser owner is at the wrong architectural layer.                                                         |
| 7. New-developer confusion            | **Fail**                               | Reusing `useWorkingTreeDiffTotals` appears to imply shared fetching, but each call owns independent work. Multiple same-name parsers/types obscure which is canonical.                                |
| 8. Wire protocol & serialization      | **Pass (static)**                      | Tauri diff schemas remain generated/typed at the boundary; HTTP git uses its own snake_case DTO. No live payload was emitted during this audit. The problem is post-boundary normalization ownership. |
| 9. Init/entry-point parity            | **Fail**                               | Rust-extracted chat events and raw simulator/trajectory events use different extraction implementations; no shared golden fixture proves Rust/TS patch conversion and diff stats remain identical.    |
| 10. Resolver symmetry                 | **Fail**                               | Additions/deletions do not resolve independently in `DiffFileSection`; `unifiedDiff` is skipped as a fallback source for both fields.                                                                 |

## Term-overload table

| Term                                      | Meanings                                                                                                                                                                                                                              | Risk                                                          | Suggested name/owner                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `DiffStats`                               | CodeViewer `{ additions, deletions }`; Tauri computation `{ lines_added, lines_removed, lines_unchanged, hunks }`; work-item API `{ files_changed, lines_added, lines_removed }`; git HTTP `{ insertions, deletions, files_changed }` | Same name, incompatible field sets and semantics              | `LineDiffStats`, `DiffComputationStats`, `WorkItemImpactStats`, `GitNumstatSummary` |
| `stats`                                   | Line delta pair; file-status distribution; hunk/computation metrics                                                                                                                                                                   | Generic property names hide units                             | Include unit/domain in the name (`lineStats`, `fileStatusCounts`)                   |
| `additions` / `insertions` / `linesAdded` | Mostly the same line-count dimension expressed in UI, HTTP, Rust-wire camelCase, and snake_case                                                                                                                                       | Repeated adapters and accidental field mismatch               | Normalize once at each boundary into `LineDiffStats`                                |
| `file changes`                            | Per-file rows, aggregate changed-file count, or session edit artifacts                                                                                                                                                                | Encourages fabricated per-file data from aggregate-only input | Separate `FileChangeRow[]` from `FileChangeSummary`                                 |

## Entry-point parity matrix

| Path                                | Primary source                              | Gap policy                | Raw blank-line policy             | Start lines  | Stats source                 | Verdict                                        |
| ----------------------------------- | ------------------------------------------- | ------------------------- | --------------------------------- | ------------ | ---------------------------- | ---------------------------------------------- |
| Chat wire event                     | Rust `rustExtracted`                        | Rust-owned                | Rust-owned                        | Rust payload | Rust payload                 | Preferred source, but no shared parity fixture |
| Raw simulator/trajectory event      | TS `extractEditData` + sync patch converter | TS-owned                  | TS-owned                          | TS regex     | result fields or TS counting | Parallel fallback implementation               |
| CodeBlock diff                      | Local `diffParser`                          | Always preserve           | Treat as context                  | Yes          | Local `+/-` scan when needed | Parallel live implementation                   |
| DiffBlock / replay sections         | SessionCore parser                          | Configurable, default off | Ignore unless prefixed with space | Yes          | Extracted stats              | Most reusable implementation, wrong owner      |
| CodeEditor session replay converter | Local `parseUnifiedDiffPayload`             | Always preserve           | Treat as context                  | Yes          | Extracted edit data          | Parallel live implementation                   |
| `src/util/diff`                     | Local parser                                | Always preserve           | Treat as context                  | No           | N/A                          | No production caller found                     |

## Resolver fallback matrix (`DiffFileSection`)

| Field     | Both prop stats supplied |          Only this prop supplied | `unifiedDiff` available |    Old/new content available | Current fallback quality   |
| --------- | -----------------------: | -------------------------------: | ----------------------: | ---------------------------: | -------------------------- |
| Additions |                      Yes | **No: supplied value discarded** |                      No | Net line-count increase only | Incorrect for replacements |
| Deletions |                      Yes | **No: supplied value discarded** |                      No | Net line-count decrease only | Incorrect for replacements |

## Acceptance criteria for a cleanup

- [ ] One production unified-diff reconstruction core; surface differences are explicit options, not copied loops.
- [ ] Zero production imports of shared parsing from `SessionCore/rendering/props`.
- [ ] The definition/test-only `src/util/diff.parseUnifiedDiff` implementation is either made canonical or deleted.
- [ ] Shared golden fixtures prove identical old/new content, start lines, and line stats across CodeBlock, DiffBlock, Session Replay, and Rust-extracted/fallback paths.
- [ ] `DiffFileSection` resolves additions and deletions independently and never uses net line-length delta for modified-file stats.
- [ ] One repo-keyed working-tree totals resource owns fetch state, in-flight deduplication, debounce, and the repo-status listener.
- [ ] Mounting StartPage, plus menu, status bar, and focused rail for the same repo produces one initial numstat request and one refresh per event burst.
- [ ] Aggregate-only chat impact is not assigned to a synthetic first file.
- [ ] One canonical internal line-stat value type is used where the semantics are truly identical.
- [ ] Domain-specific reducers remain local when their input/source semantics differ.
- [ ] Targeted tests and `pnpm typecheck` pass after the unrelated baseline error is resolved.

## Recommended execution order

1. **Characterize current behavior:** add a shared fixture matrix covering multi-hunk gaps, raw blank lines, trailing newline, add/delete files, equal-length replacement, partial supplied stats, and zero-valued higher-priority sources.
2. **Create and wire the neutral parser in one change:** move the capable parser to `src/util/diff`, migrate CodeBlock, SessionCore, and fileConverter, then delete copied loops and the dead parser implementation.
3. **Fix stats resolution:** introduce a canonical `LineDiffStats` value type and an independent-field resolver; replace `DiffFileSection`'s length-delta fallback.
4. **Centralize working-tree totals:** use a repo-keyed atom/query resource with request deduplication and one listener; keep all existing UI call sites as pure consumers.
5. **Repair aggregate modeling:** let `CompactFileChanges` consume aggregate totals directly and stop fabricating first-file stats in `impactFileChanges`.
6. **Finish the UI sweep:** migrate the two hand-built badge sites identified in `docs/frontend-ui-audit-2026-07-17/DiffStatsReuseSweep.md`.

## Verification performed

| Command/check                                                    | Result                                                                        |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Four targeted Vitest files                                       | Pass: 4 files, 68 tests                                                       |
| `pnpm typecheck`                                                 | Fail: unrelated existing error at `ContextInfoButton.tsx:468`                 |
| Production call-chain sweep for parser functions                 | Three live old/new parsers; one definition/test-only parser                   |
| Working-tree totals mount/caller sweep on local `origin/develop` | Four hook call sites; StartPage and plus menu can remain mounted concurrently |
| Static wire/boundary review                                      | No wire change proposed; duplicate normalization occurs after the boundary    |

The checkout already contained extensive unrelated modified and untracked work. This audit preserved those changes and added only this report.
