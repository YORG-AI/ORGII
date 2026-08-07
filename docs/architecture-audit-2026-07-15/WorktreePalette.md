# Architecture Audit: WorktreePalette CRUD Flow

## Scope and acceptance criteria

- `src/scaffold/GlobalSpotlight/palettes/BranchPalette/index.tsx`
- `src/scaffold/GlobalSpotlight/palettes/BranchPalette/types.ts`
- `src/scaffold/GlobalSpotlight/index.tsx`

- [x] One typed source of truth controls switch/remove mode.
- [x] The embedding shell only mirrors mode for footer presentation.
- [x] Create, remove, refresh, and switch use the existing worktree API/cache
      path rather than adding parallel transport logic.
- [x] Main and active worktrees cannot enter the remove action path.
- [x] Changed TypeScript files pass ESLint and Prettier.
- [ ] Repository-wide `tsc --noEmit` is clean; currently blocked by the
      unrelated pre-existing `ContextInfoButton.tsx:468` type error.

## Ten-layer review

| Layer                                   | Coverage                                                                                                                                                                                                          | Verdict                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1. Compilation correctness              | Changed-file ESLint and Prettier pass. Repository typecheck reports only the unrelated `ContextInfoButton.tsx:468` error.                                                                                         | No changed-file issue found.                                |
| 2. Dead code and structural duplication | Traced `WorktreePalette` → `GlobalSpotlight.handleRemoveWorktree` → existing `removeGitWorktree`, plus `refreshWorktreeMap` for list invalidation. The new mode type and callback are both wired into production. | Keep. No duplicate API path introduced.                     |
| 3. Naming consistency                   | `WorktreePaletteMode` uses explicit `switch` and `remove` values; callbacks retain the existing `onRemoveWorktree` contract.                                                                                      | Keep.                                                       |
| 4. Semantic overloading                 | `remove` consistently means removing a linked checkout while preserving its branch; branch deletion remains a separate action and handler.                                                                        | Keep.                                                       |
| 5. Default-branch analysis              | The two-state union is handled with explicit equality checks; there is no catch-all that assigns future modes switch semantics.                                                                                   | Keep.                                                       |
| 6. Cross-domain leakage                 | Worktree mode stays within the Worktree palette/types. The outer Spotlight state mirrors it only to choose footer chrome.                                                                                         | Keep.                                                       |
| 7. New-developer clarity                | Mode, handlers, protected-row filter, and cache refresh names state intent directly.                                                                                                                              | Keep.                                                       |
| 8. Wire protocol                        | No wire type or payload changed. Removal continues to send the existing `worktree_path`/`force` DELETE payload.                                                                                                   | Intentionally skipped payload dump; transport is unchanged. |
| 9. Init parity                          | No initialization path changed. The only production Worktree palette call site supplies the existing create/select callbacks and the shared remove callback.                                                      | Not applicable beyond call-site trace.                      |
| 10. Resolver symmetry                   | No multi-field resolver or fallback chain changed.                                                                                                                                                                | Not applicable.                                             |

## Call path

`WorktreePalette row` → `onRemoveWorktree(skipRefresh)` →
`GlobalSpotlight.handleRemoveWorktree` → `removeGitWorktree` →
`refreshWorktreeMap` → subscribed `useWorktreeEntries` rows.

No architecture fix candidates remain in the audited scope.
