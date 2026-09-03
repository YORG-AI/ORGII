# Sidebar appearance menu UI audit

| Line                                                                        | Element                  | Verdict          | Reason                                                                                                                                                      | Suggested change |
| --------------------------------------------------------------------------- | ------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/scaffold/NavigationSidebar/blocks/SidebarSettingsMenuSubmenus.tsx:102` | Theme mode icons         | keep with reason | Uses the shared Hugeicons wrapper and small-pill icon-size token; icon-only buttons retain translated accessible labels.                                    | None.            |
| `src/scaffold/NavigationSidebar/blocks/SidebarSettingsMenuSubmenus.tsx:125` | Theme segmented control  | keep with reason | Reuses `SegmentedTextPill`, matching the compact controls already established in the adjacent Layout submenu instead of rebuilding segmented-button styles. | None.            |
| `src/scaffold/NavigationSidebar/blocks/SidebarSettingsMenuSubmenus.tsx:136` | Modify appearance action | keep with reason | Reuses the shared `DropdownItem` action-row primitive and delegates navigation to the app's settings route helper.                                          | None.            |

Verdict totals: **0 fix**, **3 keep with reason**, **0 abstract**.
