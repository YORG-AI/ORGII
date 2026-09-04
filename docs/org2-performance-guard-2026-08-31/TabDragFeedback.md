# Tab drag feedback verification

The insertion line now measures the same 32px content band as the rectangular
drop highlight in My Station and Chat Panel. My Station's band includes unused
tab space but excludes the leading and trailing header buttons. The previous
line used `TAB_BAR_HEIGHT - 8` and header/pane bounds, ignoring the window-edge
gap. It also updated its transform only when the horizontal position changed.

`src/shared/dnd/useTabInsertionIndicator.ts` owns the indicator for both hosts.
The old implementation was removed from `useTabDrag`. Reorder callbacks and
session-transfer payloads are unchanged. This is presentation geometry; there
is no persisted data or historical cleanup.

## Performance guard

| Area               | Verdict | Evidence                                                                                                             | Change or reason kept                                                                                 | Verification                                                                            |
| ------------------ | ------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Background work    | fix     | One effect owns drag-only pointer, scroll, resize, and visibility listeners plus at most one pending animation frame | No idle polling; cancel frames while hidden; remove listeners on drag end/cancel/unmount              | Idle, coalescing, visibility, and repeated cleanup tests                                |
| Memory             | fix     | One DOM indicator and one pointer position per active drag                                                           | Remove the owned indicator in cleanup; no module-global registry                                      | Three drag cycles and unmount tests                                                     |
| Scope/isolation    | fix     | Each host passes its own content-band ref                                                                            | No document-wide pane lookup or removal of another host's indicator; clip insertion x within the band | Button-area clipping tests and call-site inspection; no identity/network state involved |
| Rendering/hot path | fix     | Pointer events schedule DOM positioning without React state updates                                                  | Coalesce into one frame and remeasure on scrolling/resizing; no recurring frame loop                  | Coalescing, scroll, and vertical-only movement tests                                    |

Lifecycle coverage is limited to the shared hook in jsdom with mocked DOM
geometry. Active and idle behavior, hide/return, repeated drag end/cancel, and
unmount are covered. Real Tauri visual alignment, CPU/RSS, and native window
interaction were not exercised because desktop control was not authorized.
Network, account, provider-history, and transport matrices do not apply.

## Architecture scope

- Layer 1: Full TypeScript compilation and changed-file lint pass in the
  isolated PR worktree based on the latest `origin/develop`.
- Layers 2–7: Reviewed shared ownership, removed the old marker implementation
  and unused pane-id option, kept names specific, used measured geometry without
  header-height fallbacks, and kept session/business state out of the hook.
- Layer 9: Both production tab bars invoke the same hook with their own refs
  and expose tab ids for positioning.
- Layers 8 and 10: Not applicable; no wire serialization or multi-source
  resolver changes.

## Commands and results

```sh
pnpm exec vitest run src/shared/dnd/useTabInsertionIndicator.test.ts src/shared/dnd/sessionTabDrag.test.ts src/engines/ChatPanel/header/chatPanelHeaderLayout.test.ts src/engines/ChatPanel/ChatPanelTabBar/ChatPanelTabBar.test.ts src/modules/WorkStation/shared/TabBar/components/SortableTab/__tests__/index.test.ts
pnpm exec eslint src/shared/dnd/useTabInsertionIndicator.ts src/shared/dnd/useTabInsertionIndicator.test.ts src/modules/WorkStation/shared/TabBar/hooks/useTabDrag.ts src/modules/WorkStation/shared/TabBar/index.tsx src/engines/ChatPanel/ChatPanelTabBar/index.tsx src/engines/ChatPanel/ChatPanelTabBar/TabPill.tsx --max-warnings 0 --report-unused-disable-directives
pnpm run check:test-placement
pnpm run typecheck
git diff --check
```

- Focused tests: 45 passed across five files, including 12 marker tests.
- ESLint, test placement, and whitespace checks: passed.
- Full typecheck: passed in the isolated PR worktree. The unrelated
  Input/Textarea test edits from the original working directory are not part
  of this branch.
- Existing Vite/Sass deprecation and i18next test warnings remain.

Performance verdict: blocked for full runtime sign-off by unexecuted Tauri
visual/CPU/RSS checks. The scoped automated lifecycle checks pass; no measured
performance improvement is claimed.
