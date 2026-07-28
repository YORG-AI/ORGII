# Frontend UI Audit — in-app Changelog retirement

**Scope:** Removal of the in-app Changelog surface and temporary Settings-dropdown placeholder.
**Summary:** 3 fix, 2 keep with reason, 0 abstract.

> The repository-routed `frontend-ui-audit` skill was unavailable in both documented skill locations. This report is the manual fallback using the required design-system, duplication, arbitrary-style, accessibility, and systematic-sweep checks.

|                                                                        Line | Element                 | Verdict          | Reason                                                                                                                                 | Suggested change                                                                 |
| --------------------------------------------------------------------------: | ----------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
|                              `src/engines/ChatPanel/TabContent/registry.ts` | ChatPanel surface       | fix              | The Changelog tab and renderer no longer match the product direction toward maintained web release notes.                              | Removed the tab type, registry entry, renderer, panel, and bundled release data. |
| `src/scaffold/GlobalSpotlight/hooks/features/spotlightActionDefinitions.ts` | Global command          | fix              | A hidden dropdown item must not remain discoverable through a second in-app entry point.                                               | Removed the Changelog action and fallback.                                       |
|       `src/scaffold/NavigationSidebar/blocks/SidebarSettingsMenuButton.tsx` | Settings dropdown       | fix              | The item is temporarily unavailable, but its future location should remain explicit.                                                   | Replaced the live button with `TODO(changelog-web)` immediately above Tutorials. |
|       `src/scaffold/NavigationSidebar/blocks/SidebarSettingsMenuButton.tsx` | Tutorials item          | keep with reason | Tutorials remains the next visible item and keeps its existing shared dropdown styling, focus behavior, icon token, and event handler. | None.                                                                            |
|                                 `src/store/chatPanel/chatPanelTabsModel.ts` | Persisted state cleanup | keep with reason | A general supported-type allowlist prevents a cached retired surface from reopening or rendering a fallback flash.                     | None.                                                                            |

No new control, raw color, arbitrary Tailwind value, or untranslated visible copy was introduced. The commented placeholder deliberately has no runtime imports, handler, focus target, or accessibility surface until a real web destination exists.
