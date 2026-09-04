# GitHub detail loading UI audit

Scope: the shared GitHub issue/PR loading frame, PR tab presentation, and its
Inbox and Source Control loading hosts. Existing unrelated workspace edits are
outside this audit.

| Line                                                                                                                                                                              | Element                                        | Verdict          | Reason                                                                                                                                                                                                                                                                             | Suggested change |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/modules/shared/components/GitHubPrDetailTabs.tsx:59`                                                                                                                         | Loading and loaded PR tabs                     | keep with reason | Both states use `DetailTabStrip` and one set of existing translated labels and icons. Only unknown counts get placeholders. No duplicate tab styling or translation keys were added.                                                                                               | None.            |
| `src/modules/shared/layouts/blocks/DetailTabStrip.tsx:55`                                                                                                                         | Native tab buttons and count badges            | keep with reason | This is the shared tab primitive itself. Native buttons retain keyboard activation, selection, and panel associations; the loading badge is decorative and the tab exposes its busy state. Existing badge geometry is preserved.                                                   | None.            |
| `src/modules/shared/components/GitHubDetailSkeleton/index.tsx:30`                                                                                                                 | Content and field placeholder bars             | keep with reason | Private decorative shapes use theme fill tokens and reduced-motion support. Labels and known titles are outside the animated shapes. There are no new JavaScript timers or effects.                                                                                                | None.            |
| `src/modules/shared/components/GitHubDetailSkeleton/index.tsx:112`                                                                                                                | Known PR title                                 | keep with reason | The title and number come from the existing selection. Typography matches `GitHubFlowHeader`; the loading frame does not invent an author, status, or merge count. The existing 920px content maximum has no equivalent token in the inspected Tailwind/workstation configuration. | None.            |
| `src/modules/shared/components/GitHubDetailSkeleton/index.tsx:168`                                                                                                                | Immediate right properties pane                | keep with reason | Uses `WORKSTATION_TRAIL_WIDTH.expandedPx`, shared rail padding, `WorkstationTrailSurface`, `WorkstationTrailBody`, and `WorkstationTrailSection`. PR and issue labels use existing translations, with placeholders instead of false empty values or actionable editors.            | None.            |
| `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/detail/PrDetailPanel.tsx:90`                                                           | Initial count projection and live loading tabs | keep with reason | Existing load state gates count placeholders. Real zero/nonzero counts return after loading, and cached counts remain during refresh. Navigation remains connected to the existing per-PR selection state without adding requests or subscriptions.                                | None.            |
| `src/modules/MainApp/TeamInbox/components/TeamInboxDetailPane.tsx:110`; `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/SourceControlMainContent/index.tsx:126` | Lazy chunk fallbacks                           | keep with reason | Both hosts render the shared frame immediately. Inbox reuses its existing header actions during chunk loading and after mount. No new host-specific skeleton or configuration sweep is needed.                                                                                     | None.            |

Verdict totals: **0 fix**, **7 keep with reason**, **0 abstract**.

Source review covered design-system use, tokens, literal sizing/colors,
accessibility, and repeated presentation. Focused DOM/SSR checks cover initial
render, data loading, populated counts, cached refresh, host-owned tabs, and the
reserved sidebar width. Native-app visual checks were not run because desktop
control was not requested.

Verification on the isolated PR branch: 55 tests passed across
`GitHubDetailSkeleton`, `DetailTabStrip`, `PrDetailPanel`,
`AssignedWorkItemDetail`, `TeamInboxView.layout`, `useWorkstationPrDetail`, and
`PrSidebar`. Full `pnpm run typecheck`, scoped ESLint, Prettier, test-placement,
and diff-whitespace checks passed. Reused translation keys exist in every
locale. Unrelated local icon, label, shadow, and test edits were excluded.
Native screenshots, theme/viewport checks, and runtime CPU/RSS measurements
were not run because computer control was not requested.
