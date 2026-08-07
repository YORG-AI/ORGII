# Pane transitions UI audit

Scope: opening, closing, focusing, and resizing behavior for the primary navigation sidebar, workstation surface, and chat pane.

| Line                        | Element                        | Verdict          | Reason                                                                                                                                                                                                      | Suggested change |
| --------------------------- | ------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `viewContainerTokens.ts:25` | Shared pane transition token   | abstract         | One reduced-motion-aware token coordinates the timing and limits animation to real layout dimensions; no transform or opacity layer is introduced.                                                          | None.            |
| `viewContainerTokens.ts:35` | Chat/workstation flex geometry | abstract         | Pure helpers express visible, hidden, and focused widths as normal-flow flex values, keeping intermediate widths observable and unit-testable.                                                              | None.            |
| `SidebarBase.tsx:237`       | Sidebar width model            | keep with reason | The outer sidebar animates to zero while its existing surface retains the exact persisted expanded width behind an existing overflow clip, preventing content reflow and avoiding a duplicate render layer. | None.            |
| `SidebarBase.tsx:553`       | Sidebar interaction state      | keep with reason | Collapsed content remains mounted for the exit animation but is `aria-hidden`, non-interactive, and releases keyboard focus; the resize handle is removed only while collapsed.                             | None.            |
| `AppLayout.tsx:193`         | Chat mount policy              | keep with reason | Chat remains mounted at zero width only while a workstation route owns the slot, preserving close/open motion without retaining the heavy panel on unrelated routes.                                        | None.            |
| `AppLayout.tsx:264`         | Chat pane container            | keep with reason | The existing chat container stays in normal flex flow and transitions its exact configured width; it does not create an absolute overlay when focused.                                                      | None.            |
| `AppLayout.tsx:298`         | Workstation surface            | keep with reason | Workstation and chat exchange flex growth in the existing row, and transition completion re-notifies native webview layout consumers.                                                                       | None.            |
| `useChatPanelResize.ts:144` | Manual chat resize             | keep with reason | A shared transient dragging atom disables pane transitions during direct manipulation, so the rendered edge tracks the pointer without easing lag.                                                          | None.            |
| `useNarrowChatFocus.ts:110` | Narrow-layout width evaluation | fix              | Programmatic reopen now evaluates the projected target width instead of transient animation frames, preventing chat from immediately re-maximizing and hiding the center resize handle.                     | None.            |
| `AppLayout.tsx:202`         | Shared pane-row underlay       | keep with reason | The existing flex row paints the theme-aware chat surface beneath both panes, preventing background flashes from subpixel rounding without adding another DOM or absolute layer.                            | None.            |
| `ChatPanelShell.tsx:51`     | Full-height resize divider     | fix              | The existing 1px handle overlaps inside the exact pane width and sits above pinned headers and the composer, keeping its line and hit area continuous without changing width calculations.                  | None.            |

## Summary

- Fix: 2
- Keep with reason: 7
- Abstract: 2
- Sweep candidates: 0
