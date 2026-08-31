# Session actions delivery audit

| Line                                                                                  | Element                       | Verdict          | Reason                                                                                                                                                                  | Suggested change                                                            |
| ------------------------------------------------------------------------------------- | ----------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `src/engines/ChatPanel/components/SessionHeaderActionsMenu.tsx:211`                   | Shared action menu            | keep with reason | Uses shared dropdown rows, icons, separators, and width tokens in all three session hosts; move, copy/export, project links, and UI settings are second-level groups    | None                                                                        |
| `src/engines/ChatPanel/components/SessionActionsMenuSurface.tsx:29`                   | Menu tree                     | keep with reason | One keyboard owner handles focus, Escape, and left-opening flyouts; right-facing chevrons are the explicitly requested presentation                                     | Preserve behavior during the separate shared-overlay refactor               |
| `src/engines/ChatPanel/components/SessionOpenInAppMenuItem.tsx:122`                   | Native-app row                | keep with reason | Destination brand and up-right arrow are retained; unsupported/pending plans leave no empty app section; native backend remains authoritative                           | None                                                                        |
| `src/scaffold/NavigationSidebar/connectors/SessionImportExportModal.tsx`              | Export dialog                 | keep with reason | Wider export presentation removes the redundant introduction while import keeps its guidance and validation                                                             | None                                                                        |
| `src/components/Tooltip/index.tsx:261`, `src/components/Dropdown/submenuLayout.ts:54` | Inter-panel clearance         | keep with reason | Unscaled tooltip dimensions and parent-panel anchoring produce the shared resting 3px gap independently of inset rows; this preserves the accepted Appearance reference | The follow-up will make the separate proposed 4px system-wide policy change |
| `src/engines/ChatPanel/InputArea/components/PinnedActionsBar/PinActionsPanel.tsx:303` | Pinned skill preview clipping | fix candidate    | The existing outer header-panel class clips its absolute child even with a correct gap; this PR changes the gap, not the clipping ownership                             | Repair through the follow-up positioning/surface boundary                   |

Verdict totals: **1 fix candidate**, **5 keep with reason**, **0 abstract**.

## Scope and invariants

- Conversation mute is removed from the menu, hook, policy evaluator, summary coordinator, settings schema/projection, cancellation toast, settings UI, and 13 locale files. Global/category/quiet-hours notification settings are preserved. Old mute values are ignored on validation and omitted on settings regeneration; no persisted file is proactively rewritten or deleted.
- Copy event JSON, URL, and Export JSON share one flyout. Move page to, project links, and UI settings have separate flyouts. The raw-transcript menu item is gone; the raw view itself remains available through its existing view controls.
- Native-app opening moves from the toolbar into a direct separated menu row. Claude/Codex capability gating and existing native RPCs are unchanged. Integration with develop preserves its separately parked CLI continuation header button. Missing source disables the action; backend failure still reports an error.
- Export-only dialog width and introduction change; import behavior does not.
- Shared nested-panel spacing and Tooltip use the current 3px token. Moving to a single neutral 4px overlay token belongs to the separate follow-up, not this snapshot PR.

## Architecture coverage

Layers 1–10 were reviewed: compilation; removed hook/launcher call chains; renamed menu rows and localizations; native app versus CLI/window terminology; unsupported/missing defaults; source-descriptor brand ownership; shared-host readability; unchanged native RPC payloads; all three host entry points; and symmetric plan/name/icon resolution. Notification settings no longer expose a mute field at any producing or consuming boundary. No Rust, database, external wire, or dependency changes are included.

## Lifecycle review

| Area               | Verdict | Evidence                                                                                   | Change or reason kept                                                                         | Verification                                                             |
| ------------------ | ------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Background work    | keep    | One finite app-plan lookup per supported menu open; stale effect results discarded         | No polling or new refresh loop; summary scheduler unchanged apart from removed mute filtering | App-plan request-count/session-switch tests and summary fake-timer tests |
| Memory             | keep    | One active submenu, one plan, local launch guard; menu unmount drops state                 | No added app-lifetime cache                                                                   | Menu close/reopen and cleanup tests                                      |
| Scope/isolation    | keep    | Native action keyed by session; backend still builds and opens its own validated deep link | No new account/org cache or client-supplied launch URL                                        | Session-switch and backend-rejection tests                               |
| Rendering/hot path | keep    | Only active flyout content mounts; geometry work is limited to visible overlays            | Unrelated layout/terminal changes excluded from this branch                                   | Shared menu/tooltip/geometry component tests                             |

Performance verdict: **blocked for native measurement only**. Automated lifecycle checks pass; visible/hidden CPU/RSS, actual OS app launch, secondary-window execution, and screen-reader behavior were not exercised. No runtime performance improvement is claimed.

## Verification

Executed against an isolated worktree based on the latest fetched develop branch:

```sh
pnpm exec vitest run src/components/Dropdown src/components/Tooltip src/engines/ChatPanel/components/SessionHeaderActionsMenu.test.ts src/scaffold/NavigationSidebar/blocks/SidebarSettingsMenuButton.test.ts src/engines/ChatPanel/ChatPanelHeader.test.ts src/api/tauri/externalHistory/imported/__tests__/sources.test.ts src/scaffold/NavigationSidebar/connectors/__tests__/SessionImportExportModal.test.ts src/engines/ChatPanel/hooks/useSessionHeaderActions.test.ts src/api/services/notification.test.ts src/api/services/notificationPolicy.test.ts src/api/services/notificationSummaryCoordinator.test.ts src/config/settingsSchema/__tests__/notificationSettings.test.ts src/hooks/notifications/useNotificationApprovalBridge.test.ts src/hooks/session/__tests__/sessionTerminalNotifications.test.ts src/modules/MainApp/Settings/__tests__/NotificationsSettings.test.ts
pnpm run check:test-placement
pnpm run typecheck
git diff --cached --name-only --diff-filter=ACMR -- '*.ts' '*.tsx' | xargs pnpm exec eslint --max-warnings 0
git diff --check
```

- Targeted tests: **22 files, 172 tests passed**. Expected failure-fixture logs and existing Sass/Vite deprecation messages were emitted.
- Test placement: consistent across 434 directories.
- Full TypeScript typecheck: passed. The unrelated Input/Textarea tests from the original dirty checkout are not part of this branch.
- ESLint: all changed/new TypeScript files passed with `--max-warnings 0`.
- Source sweep: no production references to the removed mute field/hook or old toolbar launcher remain.
- No native screenshots or desktop UI control were taken: computer control was not authorized. Existing screenshot references guided the layout; automated tests cover structure, callbacks, dimensions, and finite lifecycle, not a native visual acceptance pass.

Rollback is a commit revert. Removed source remains recoverable in Git; conversation/event data is untouched. If settings are saved after upgrade, the obsolete mute preference will no longer be serialized and would need reconfiguration after rollback.
