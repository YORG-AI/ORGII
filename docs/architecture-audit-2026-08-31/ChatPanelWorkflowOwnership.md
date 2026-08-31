# Chat panel workflow ownership

Scope: give creation workflows and tab access reconciliation named owners while keeping their state/effects at the existing chat host lifetime. The host retains layout, tabs, chrome, session presentation, and keep-alive policy.

## Architecture coverage

| Layer                      | Review and result                                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. Compilation             | Full TypeScript check, targeted lint, and behavior tests passed                                                                                                    |
| 2. Dead code / duplication | Move existing code into two live hooks; remove corresponding host imports/state/callbacks                                                                          |
| 3. Naming                  | `useChatPanelCreationContent` and `useChatPanelAccessReconciliation` describe their ownership                                                                      |
| 4. Semantic overloading    | Host passes eight presentation/chrome inputs; creation atoms, draft state, API-key/update actions, and agent context stay private to the creation owner            |
| 5. Defaults                | Slot availability initialization, creator variant, create-target defaults, and cancellation paths preserved                                                        |
| 6. Domain boundaries       | Existing project/work-item/AI handlers remain authoritative; host no longer imports their domain data                                                              |
| 7. Discoverability         | Feature workflows can be read independently of layout and session rendering                                                                                        |
| 8. Wire format             | No API, IPC, schema, payload, storage, or protocol changes                                                                                                         |
| 9. Initialization parity   | Hooks are unconditional; creator state remains mounted while its returned content is hidden. Access effects retain ordering, dependencies, and cancellation guards |
| 10. Resolver symmetry      | Existing AI context and create-target resolution reused without modifications                                                                                      |

The existing `ChatPanelEmptyContent` view contract remains internal to the creation owner. This deliberately avoids introducing a conditionally mounted connected component: doing so would discard drafts and creator choices when a session/tab hides it. No extra DOM wrapper is introduced. The owner reuses the host translator and start-page value; access reconciliation also reuses the host selection. This preserves the original translation and atom subscription count.

## Behavior and lifecycle evidence

| Area               | Verdict | Evidence                                                                                | Change or reason kept                                            | Verification                                   |
| ------------------ | ------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| Background work    | keep    | Three existing access effects, unchanged guards/dependencies                            | Still reconcile while content is hidden; no new timer or polling | Unknown/loaded roster and hidden-content tests |
| Memory             | keep    | Draft and creator toggles remain host-owned hook state                                  | Same lifetime and reset actions                                  | Hide/show retains draft and manual choices     |
| Scope/isolation    | keep    | Authoritative roster gates reconciliation; alias lookup uses existing cancellation flag | No stale completion after roster change/unmount                  | Deferred lookup regression test                |
| Rendering/hot path | keep    | Same `ChatPanelEmptyContent` element and props; session rendering untouched             | No new component wrapper or claim of fewer renders               | Existing transcript keep-alive tests           |

Performance verdict: blocked for real-app CPU/RSS and repeated Tauri open/close measurement; computer control was not authorized. The targeted lifecycle behavior is tested, and no runtime speed or memory improvement is claimed.

## Verification

- `pnpm run typecheck --incremental --tsBuildInfoFile "$(git rev-parse --git-path chat-host-final.tsbuildinfo)"`: full-project check passed
- Integrated latest develop `55392aa43`; retained its new header actions menu and visibility guard. AST comparison against that base also confirms the updated menu is unchanged except for direct callback aliases

- `pnpm exec vitest run --config config/vitest.config.ts src/engines/ChatPanel/hooks/useChatPanelCreationContent.test.ts src/engines/ChatPanel/hooks/useChatPanelAccessReconciliation.test.ts src/engines/ChatPanel/hooks/useProjectWorkItemHandlers.test.ts src/engines/ChatPanel/ChatPanelContent.test.ts --maxWorkers=2 --minWorkers=1`: 4 files, 14 tests passed
- Targeted ESLint, circular dependency check (6,344 modules), test-placement check, and `git diff --check`: passed
- TypeScript AST-printer comparison: nine moved initializers/JSX, three feature-hook calls, and all three access effects match the base implementation
- No live Tauri, visual E2E, backend tests, or full suite; existing view markup and domain handlers are untouched

No dependency, configuration, persistence, API, or migration changes. Reverting this commit restores inline ownership without data recovery.
