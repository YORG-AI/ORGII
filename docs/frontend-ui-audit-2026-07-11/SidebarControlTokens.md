# Sidebar control tokens UI audit

Scope: selected and hover token consistency for shared sidebar controls.

| Line                                    | Element                     | Verdict          | Reason                                                                                                                                                       | Suggested change |
| --------------------------------------- | --------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `Select/index.scss:104`                 | Ghost Select state override | abstract         | Optional CSS custom properties let a containing surface supply semantic hover/open colors while preserving the existing Select defaults everywhere else.     | None.            |
| `SidebarOrgSelector.tsx:69`             | Organization selector       | fix              | The sidebar selector previously inherited generic Select surface colors; its hover and open states now use the sidebar selected-row token.                   | None.            |
| `SessionFilterButton.tsx:133`           | Group filter button         | fix              | The open state previously used generic active-button and primary-text colors; hover and open now use sidebar selected-row plus normal foreground tokens.     | None.            |
| `SidebarSettingsMenuButton.tsx:129`     | Settings control            | fix              | The selected Settings control previously used background and primary accent tokens; it now shares the sidebar selected-row and text tokens.                  | None.            |
| `SettingsSidebar.tsx:72`                | Selected Settings footer    | fix              | The Settings footer selection now uses the same sidebar selected-row treatment rather than the legacy primary-accent treatment.                              | None.            |
| `NavigationMenuRow.tsx:171`             | Sidebar row action states   | abstract         | Shared row action components now inherit normal foreground for selected states, preventing individual menu actions from restoring the legacy primary accent. | None.            |
| `SidebarRamMonitorButton/index.tsx:248` | Performance monitor control | keep with reason | Its open state follows the same sidebar selected-row and foreground tokens as Settings while retaining its existing semantic animation and interaction.      | None.            |

## Summary

- Fix: 4
- Keep with reason: 1
- Abstract: 2
- Sweep candidates: 0
