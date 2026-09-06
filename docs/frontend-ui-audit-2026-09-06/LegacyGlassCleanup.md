# Legacy Glass Cleanup UI audit

Scope: removal of the unreachable dock component and archived background UI,
pruning dead exports and ActivityRouter presentation styles, and replacing the
remaining chat header blur with a solid surface. Surviving controls retain their
existing rendered structure and design-system usage.

## D1 — Raw HTML vs Design System

| Line                                        | Element                       | Verdict          | Reason                                                                                                                                                                                     | Suggested change |
| ------------------------------------------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `DockContextMenu.tsx:174`                   | Positioned menu panel `<div>` | keep with reason | The element owns callback-ref positioning and hover lifecycle while reusing the shared dropdown panel tokens; there is no additional presentation logic that warrants a component wrapper. | None.            |
| `DockContextMenu.tsx:191`                   | Menu action `<button>`        | keep with reason | A native button provides the correct disabled and keyboard semantics, and its presentation comes from `DROPDOWN_CLASSES.menuActionItem`.                                                   | None.            |
| `dockLayout.tsx:76`                         | Dock icon-strip `<div>`       | keep with reason | This is a layout-only primitive used by the replay dock; it has no independent interaction or surface styling.                                                                             | None.            |
| `ChatPanelHeader.tsx:471`                   | Header surface `<div>`        | keep with reason | The pointer-inert element owns the shared header geometry and uses the opaque `bg-chat-pane` token without introducing another component abstraction.                                      | None.            |
| `SessionDerivedViewShell.tsx:82`            | Summary surface `<div>`       | keep with reason | The layout-only summary strip reuses the same opaque header token when inset beneath the floating header and keeps its semantic content in the caller.                                     | None.            |
| `ActivityRouter.tsx:349`                    | Activity wrapper `<div>`      | keep with reason | The wrapper carries the stable `.activity-chat-item` hook used to suppress empty projected rows and provides the workspace-root context boundary.                                          | None.            |
| `events/stream/agent-message/index.tsx:102` | Reasoning content `<div>`     | keep with reason | The event renderer needs a lightweight container for shared reasoning typography; the same class contract is used in only two event renderers, below the extraction threshold.             | None.            |
| `events/stream/thinking/index.tsx:174`      | Thinking content `<div>`      | keep with reason | The event renderer adds its own streaming cursor and collapse structure while reusing the shared inline reasoning presentation.                                                            | None.            |

## D2 — Arbitrary Tailwind Value vs Token

| Line                      | Element                   | Verdict          | Reason                                                                                                                                                              | Suggested change |
| ------------------------- | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `DockContextMenu.tsx:176` | `min-w-180`               | keep with reason | The width uses the repository’s `--spacing-180` Tailwind token and preserves the existing menu fit.                                                                 | None.            |
| `dockLayout.tsx:78`       | Fixed dock-strip geometry | keep with reason | The 48px strip and 6px horizontal padding align the existing 36px dock hit targets and trailer rows; these are shared dock geometry rather than one-off decoration. | None.            |

## D3 — Hardcoded Sizes / Colors

| Line                | Element                            | Verdict          | Reason                                                                                                                                | Suggested change |
| ------------------- | ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `popupTokens.ts:20` | Tutorial popup light/dark surfaces | keep with reason | These values preserve the former thick popup appearance, are independent of the selected background, and now have one semantic owner. | None.            |

## D4 — Accessibility Basics

| Line                      | Element            | Verdict          | Reason                                                                                                         | Suggested change |
| ------------------------- | ------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------- | ---------------- |
| `DockContextMenu.tsx:191` | Current-app action | keep with reason | The native `disabled` attribute prevents activation and exposes the unavailable state to assistive technology. | None.            |

## D5 — Repeated Visual / Structural Patterns

| Line                                                                                   | Element                   | Verdict  | Reason                                                                                                            | Suggested change                                           |
| -------------------------------------------------------------------------------------- | ------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `GeneralLayoutTour.tsx:268`, `CodeEditorTour.tsx:296`, `GuideHighlightOverlay.tsx:123` | Tutorial popup surface    | abstract | Three tutorial overlays previously depended on the legacy Glass configuration for the same static surface values. | Centralize the static surface in `getPopupSurfaceStyle`.   |
| `DockContextMenu.tsx:176`, `DockContextMenu.tsx:185`, `DockContextMenu.tsx:192`        | Context-menu presentation | abstract | The former bespoke Glass panel and item styling duplicated the established dropdown system.                       | Reuse `DROPDOWN_CLASSES` panel, column, and action tokens. |

Verdict totals: **0 fix**, **12 keep with reason**, **2 abstract**.
