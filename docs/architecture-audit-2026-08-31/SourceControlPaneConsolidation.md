# Source Control pane consolidation

Scope: remove the duplicate connected main-repository adapter without changing the UI, state source, selection semantics, or scope lifecycle.

## Architecture coverage

| Layer                      | Review and result                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation             | Full TypeScript check, targeted lint, and behavior tests passed                                                           |
| 2. Dead code / duplication | Removed `MainRepoSectionContent`; its 123-line callback body was byte-identical to the retained `SourceControlTabContent` |
| 3. Naming                  | Both hosts now name the same connected repository pane                                                                    |
| 4. Semantic overloading    | Repository identity remains `repoId` plus `repoPath`; worktree identity remains separate                                  |
| 5. Defaults                | Prop defaults and `navigateWithoutSelecting` branches unchanged                                                           |
| 6. Domain boundaries       | `useSourceControlState` remains the owner; worktree and multi-root adapters intentionally remain distinct                 |
| 7. Discoverability         | One adapter to update for standalone and worktree-hosted main repositories                                                |
| 8. Wire format             | Not applicable: no API, IPC, payload, schema, or persistence changes                                                      |
| 9. Initialization parity   | Both live hosts use the same hook/options; existing scope key, forwarded refs, and loading callback remain                |
| 10. Resolver symmetry      | No resolver changes; file-selection lookup and fallback are unchanged                                                     |

## Behavior and lifecycle evidence

`SourceControlTabPanels.behavior.test.ts` renders both live hosts with both selection modes. It checks repository/options forwarding, file reporting with scope root, selection versus navigation behavior, DOM retention on rerender, loading overlay settlement, and imperative refresh. Existing scope-switch/picker/initialization tests remain unchanged.

| Area               | Verdict | Evidence                                                                  | Change or reason kept                | Verification                              |
| ------------------ | ------- | ------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------------- |
| Background work    | keep    | Same single `useSourceControlState` per active pane                       | No new subscription or request owner | Hook inputs asserted in both hosts        |
| Memory             | keep    | Existing refs and scope-keyed child                                       | No additional retained pane or cache | Same DOM node after rerender              |
| Scope/isolation    | keep    | Main repo keeps `key={scopeKey}` and `mainRef`; worktree branch unchanged | Preserve remount and refresh routing | Scope tests and both-host refresh test    |
| Rendering/hot path | keep    | Shared callback body unchanged; no markup/style changes                   | Remove duplicate source only         | Selection and forwarding regression tests |

Performance verdict: blocked for real-app CPU/RSS and repeated Tauri open/close measurement; computer control was not authorized. Structural/lifecycle assertions passed, and no runtime performance improvement is claimed.

## Verification

- `pnpm run typecheck --incremental --tsBuildInfoFile "$(git rev-parse --git-path source-control-final.tsbuildinfo)"`: full-project check passed

- `pnpm exec vitest run --config config/vitest.config.ts src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/tabs/__tests__ --maxWorkers=2 --minWorkers=1`: 4 files, 45 tests passed
- Targeted ESLint: passed
- `pnpm run check:circular`: passed, 6,341 modules
- `git diff --check`: passed
- No live Tauri/visual E2E, backend tests, or full test suite: underlying view markup and Git operations were not modified

No dependency, configuration, storage, protocol, or migration changes. Reverting this commit restores the duplicate adapter without data recovery.
