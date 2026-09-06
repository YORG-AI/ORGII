# Legacy Glass Cleanup UI audit

Scope: removal of the unreachable dock component and archived background UI,
plus pruning dead exports. The surviving dock controls keep their existing
rendered structure and design-system usage.

## D1 — Raw HTML vs Design System

| Line                      | Element                       | Verdict          | Reason                                                                                                                                                                                     | Suggested change |
| ------------------------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `DockContextMenu.tsx:174` | Positioned menu panel `<div>` | keep with reason | The element owns callback-ref positioning and hover lifecycle while reusing the shared dropdown panel tokens; there is no additional presentation logic that warrants a component wrapper. | None.            |
| `DockContextMenu.tsx:191` | Menu action `<button>`        | keep with reason | A native button provides the correct disabled and keyboard semantics, and its presentation comes from `DROPDOWN_CLASSES.menuActionItem`.                                                   | None.            |
| `dockLayout.tsx:76`       | Dock icon-strip `<div>`       | keep with reason | This is a layout-only primitive used by the replay dock; it has no independent interaction or surface styling.                                                                             | None.            |

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

Verdict totals: **0 fix**, **7 keep with reason**, **2 abstract**.
