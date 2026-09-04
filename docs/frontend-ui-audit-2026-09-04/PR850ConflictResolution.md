# PR 850 conflict-resolution UI audit

| Line | Element | Verdict | Reason | Suggested change |
| --- | --- | --- | --- | --- |
| `src/scaffold/NavigationSidebar/blocks/SidebarGroup.tsx:89` | Collapsible group header | fix candidate | A clickable `div` has no keyboard role or key handling; the adjacent add action prevents a simple nested-button conversion. | Split the row into a native toggle button for the leading/header surface and a sibling add button, while preserving the existing row-action control. |
| `src/scaffold/NavigationSidebar/connectors/SidebarOrgSelector.tsx:92` | Manage/add/sign-in dropdown actions | abstract | Three actions repeat the same dropdown-token button shell and differ only by icon, label, handler, and test id. | Extract a local `SidebarOrgSelectorAction` that owns the dropdown classes, icon rendering, and native button semantics. |
| `src/features/Org2Cloud/SessionComments/CommentThreadList.tsx:102` | Mention and agent metadata typography | keep with reason | The sub-`text-xs` sizes and exact truncation widths form a dense collaboration-metadata scale; the current theme defines no equivalent typography tokens. | None until a shared compact-metadata type scale is introduced. |
| `src/features/Org2Cloud/SessionComments/CommentThreadList.tsx:349` | Agent suggestion button | keep with reason | This is an in-composer suggestion row with mouse-down focus preservation and a full-row hit area that the standard button variants do not express. | None. |
| `src/features/Org2Cloud/SessionComments/CommentThreadList.tsx:514` | Thread-status segmented buttons | keep with reason | Native buttons provide pressed and disabled semantics inside one contiguous three-state control; replacing one segment with a general button would fragment the shared border and focus treatment. | None. |
| `src/web/features/sessions/WebSessionCommentsHeaderExtras.tsx:45` | Notes modal scroll bound | keep with reason | `60vh` is a viewport-relative clipping bound for the modal body, not a reusable fixed spacing or size token. | None. |
| `src/engines/Simulator/components/RemoteSessionWorkspaceSurface.tsx:196` | Streaming banner metadata | keep with reason | The 11px label matches the existing compact status-bar density and no equivalent theme typography token exists below `text-xs`. | None. |

Verdict totals: **1 fix**, **5 keep with reason**, **1 abstract**.
