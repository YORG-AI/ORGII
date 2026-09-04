# Sidebar first history header UI audit

| Line                            | Element                        | Verdict          | Reason                                                                                                           | Suggested change |
| ------------------------------- | ------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| `sidebarMenuCollections.ts:141` | First generated session header | keep with reason | Skips Pinned and decorates the first regular time, agent, or workspace section instead of adding another heading | None             |
| `sidebarMenuCollections.ts:152` | Search header action           | keep with reason | Reuses the existing `NavigationMenuRowActionButton` and `Search01Icon` contract                                  | None             |
| `sidebarMenuCollections.ts:160` | Refresh header action          | keep with reason | Uses the existing `NavigationMenuRowActionButton` contract and shared `Refresh04Icon`/`useRefreshSpin` behavior  | None             |
| `NavigationSidebar.tsx:460`     | Inline session search          | keep with reason | Reuses the shared `SidebarMenuSearchInput`; autofocus is opt-in and fixed navigation remains visible             | None             |

Verdict totals: **0 fix**, **4 keep with reason**, **0 abstract**.
