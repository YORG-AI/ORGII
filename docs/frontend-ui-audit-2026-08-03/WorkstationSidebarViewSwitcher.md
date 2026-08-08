# WorkstationSidebarViewSwitcher frontend UI audit

Scope: the new icon-only Workstation view switcher rendered below the organization selector. The configured `frontend-ui-audit` skill was unavailable, so this report applies the repository's documented checks manually.

| Line                                        | Element                                        | Verdict          | Reason                                                                                                                                                      | Suggested change |
| ------------------------------------------- | ---------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `WorkstationSidebarViewSwitcher.tsx:48`     | Semantic navigation container                  | keep with reason | Uses a translated navigation label and remains directly on the existing sidebar surface without introducing a second container background or sidebar layer. | None.            |
| `WorkstationSidebarViewSwitcher.tsx:29`     | Horizontal destination order                   | keep with reason | Work Items leads, History/Sessions occupies the central position, and Chat/Channels remains last, matching the requested information hierarchy.             | None.            |
| `WorkstationSidebarViewSwitcher.tsx:53`     | Horizontal view row                            | keep with reason | Equal-width targets make the three icon-only destinations read as one balanced row while preserving the sidebar background around them.                     | None.            |
| `WorkstationSidebarViewSwitcher.tsx:58`     | Delayed icon tooltips                          | keep with reason | Translated tooltip labels appear only after 1.5 seconds of hover, while `aria-label` keeps every icon-only destination immediately accessible.              | None.            |
| `WorkstationSidebarViewSwitcher.tsx:67`     | View controls                                  | keep with reason | Uses 28px targets, visible keyboard focus, a 70%-opacity chat-pane selected surface, and the same `sidebar-selected` hover token as the menu rows below.    | None.            |
| `SidebarOrgSelector.tsx:140`                | Organization selector tooltip                  | keep with reason | The existing selector tooltip remains disabled while its menu is open and now uses the same 1.5-second hover delay as the view tabs.                        | None.            |
| `WorkstationSidebarConnector/index.tsx:589` | Organization selector and switcher composition | keep with reason | The organization selector stays in the sidebar chrome, while `preListContent` places the switcher directly below it and above the contextual list.          | None.            |
| `WorkstationSidebarConnector/index.tsx:613` | Direct Work Items content                      | keep with reason | Work Items now uses the same list spacing and top-level switcher behavior as Channels and Sessions; no back header or nested navigation layer is rendered.  | None.            |
| `workstationSidebarMenuItems.tsx:57`        | Sessions pinned actions                        | keep with reason | Sessions contains only session-level actions; Work Items is no longer duplicated there because the top-level switcher is its sole sidebar destination.      | None.            |

## Verdict counts

- Fix: 0
- Keep with reason: 9
- Abstract: 0

No multi-file design-system sweep candidate was found.
