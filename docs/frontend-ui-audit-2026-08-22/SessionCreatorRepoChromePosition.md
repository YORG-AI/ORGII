# Session Creator repository chrome menu UI audit

The documented `frontend-ui-audit` skill was unavailable at both the global and workspace paths. This manual fallback applies the repository's required design-system, spacing, localization, and accessibility checks to the changed UI.

| Line / file                       | Element                            | Verdict          | Reason                                                                                                                                                                     | Suggested change |
| --------------------------------- | ---------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `RepoChromeRow.tsx`               | Secondary-click native menu        | keep with reason | Uses the shared Tauri native-menu lifecycle, prevents the WebView menu, and exposes only the applicable move plus show/hide commands instead of redundant checked choices. | None.            |
| `PinnedActionsBar/index.tsx`      | Hidden pinned-action presentation  | keep with reason | Hides only quick-action pills; the shared `…` manager and unrelated leading/trailing setup controls remain discoverable and keyboard-accessible.                           | None.            |
| `SessionCreatorChatPanelView.tsx` | Creator visibility projection      | keep with reason | Applies the persisted choice only where the repository chrome menu can restore it; compact and hidden-repo creators keep pinned actions visible.                           | None.            |
| `repoChromeLayout.ts`             | Position-aware padding and glow    | keep with reason | Both sides mirror `1.5` outer / `2.5` seam padding, while the launchpad glow is intentionally limited to top chrome so it cannot paint across the bottom seam.             | None.            |
| `index.scss`                      | Top and bottom composer attachment | keep with reason | The established negative seam overlap, corner radii, and z-order remain unchanged; the follow-up does not alter visual layering.                                           | None.            |
| `locales/*/sessions.json`         | Contextual native-menu commands    | keep with reason | All supported locales define Move to top/bottom and Show/Hide pinned actions; no locale relies on raw English UI copy.                                                     | None.            |

Verdict totals: **0 fix**, **6 keep with reason**, **0 abstract**.

No multi-file sweep candidate was found: this is the only independently movable repository chrome in Session Creator, while Workstation panel position controls represent a different surface and axis.
