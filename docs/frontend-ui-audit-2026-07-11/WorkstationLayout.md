# Workstation layout UI audit

Scope: UI files changed while removing the compact/comfort choice, retaining the former compact geometry, and using the former comfort sidebar palette.

| Line                                        | Element                      | Verdict          | Reason                                                                                                                                                          | Suggested change |
| ------------------------------------------- | ---------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SidebarWorkstationSettingsSubmenu.tsx:155` | Workstation settings rows    | keep with reason | The layout-density selector is gone; the remaining controls reuse the shared `SelectionRow`, dropdown tokens, translated labels, and selected-state affordance. | None.            |
| `WorkStationShell/index.tsx:230`            | Primary sidebar shell        | keep with reason | The shell uses one docked geometry path, the former comfort editor-canvas palette, and the existing bordered resize handle.                                     | None.            |
| `WorkStationShell/index.tsx:282`            | Secondary panel shell        | keep with reason | The panel keeps the old compact surface and border-resize treatment without duplicating conditional layout classes.                                             | None.            |
| `PropertiesRailFrame.tsx:49`                | Properties rail              | keep with reason | The rail preserves the old compact full-height bordered presentation and uses existing semantic color tokens.                                                   | None.            |
| `AppShell/index.tsx:213`                    | Status bar and dock boundary | keep with reason | The status bar is permanently docked and the dock keeps the compact top border, matching the requested default style.                                           | None.            |
| `BrowserLayout/index.tsx:199`               | Browser viewport inset       | keep with reason | Zero bottom inset preserves the old compact edge-to-edge viewport geometry.                                                                                     | None.            |

## Summary

- Fix: 0
- Keep with reason: 6
- Abstract: 0
- Sweep candidates: 0
