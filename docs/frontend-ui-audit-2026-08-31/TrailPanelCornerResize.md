# Workstation trail terminal controls UI audit

| Line                                     | Element                           | Verdict          | Reason                                                                                                                                                                                                                           | Suggested change |
| ---------------------------------------- | --------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ProcessStopButton/index.tsx:16`         | Process stop primitive            | keep with reason | One shared control now serves the dock, main terminal, both terminal sidebar row types, Open Tabs, and server watcher; always-red styling preserves the watcher reference without changing the generic muted danger-button token | None             |
| `WorkstationTrailTerminalHeader.tsx:65`  | Inline terminal header            | keep with reason | One terminal uses its exact name once in the title slot; multiple expanded terminals omit the title and show chevron plus tabs; the content retains a valid accessible label through both modes                                  | None             |
| `WorkstationTrailTerminalHeader.tsx:179` | Compact terminal tabs             | keep with reason | Tabs hug labels at 20px height with 1px gaps and rounded-lg corners, matching their neighboring controls; native horizontal scrolling and local selection reveal are preserved                                                   | None             |
| `WorkstationTrailTerminalHeader.tsx:98`  | Three-terminal limit              | keep with reason | Add is absent at three in expanded and folded states; the shared claim/create writer enforces the same limit before creating a session; no overflow menu remains                                                                 | None             |
| `WorkstationTrailSurface.tsx:43`         | Shared control size and alignment | keep with reason | BUTTON_SIZE.sm supplies the requested 20px controls across trails; 24px rows center them, while explicit 3px right padding preserves icon centers; the action wrapper reuses TAB_BAR_TRAILING_CLUSTER_CLASS for tab-bar spacing  | None             |
| `TrailPanelResizeHandle.tsx:20`          | Corner target and glyph           | keep with reason | Native 20px grip follows the requested control size, with pointer and keyboard resizing, named colors and visible focus; the decorative currentColor SVG describes a two-axis corner interaction                                 | None             |
| `WorkstationTrailTerminal.tsx:164`       | Terminal grip clearance           | keep with reason | Only the expanded terminal reserves footer space and renders a grip; folded state removes both and restores saved dimensions on expansion                                                                                        | None             |
| `index.tsx:676`                          | Fixed Workstation Trail           | keep with reason | Trail sizing follows the shipped 256px column/248px surface; edge drag, corner grip, height override, width menu, and old preference readers are removed per the user's correction                                               | None             |
| `types.ts:31`                            | Stop versus close/hide            | keep with reason | Process actions are explicit; file close, dock hide, and read-only view close retain X controls and do not gain process termination behavior                                                                                     | None             |
| `WorkstationTrailTerminal.tsx:198`       | Pinned terminal font              | keep with reason | A 12px host override reaches xterm initialization and live appearance updates through TerminalCore and TerminalView; no CSS scaling, global setting write, or terminal remount is introduced                                     | None             |
| `index.tsx:786`                          | Collapsed shortcut tooltips       | keep with reason | ToolbarTooltip receives the existing label, status and shortcut metadata; native titles are removed to avoid duplicate tooltips, and unmount cleanup is tested                                                                   | None             |

Verdict totals: **0 fix**, **11 keep with reason**, **0 abstract**.

The requested stop-control sweep is implemented through one shared component,
not a global danger-token change. The expanded terminal minimum is 320px to keep
the terminal name or scrollable tabs and controls on one row. Labels and count
plurals are supplied in all 13 locales. No additional config-level sweep remains.

Rendered jsdom integration verifies three-terminal admission, repeated clicks, local horizontal scrolling and keyboard focus,
stop/hide semantics, folded process counts, mount retention and restored sizing.
No native screenshots, theme checks, or actual xterm geometry were captured:
computer control was not authorized. These remain verification limitations.

The requested size sweep is applied at the shared control and header, including
project/work-item PropertiesPanel and PR section controls. The trailing center
remains at the same nominal offset: old `26 / 2 = 13px`; new `3 + 20 / 2 = 13px`.
The surface and outer rail insets remain unchanged, preserving the tab-bar icon
alignment. Collapsed narrow rails retain centered controls without the new
one-sided padding. Terminal single/multiple transitions, 20px controls and 1px
gaps are covered by the dock integration suite; project and PR consumers pass
their targeted suites. Native pixels/themes were not visually measured.

Expanded trail controls and pinned-terminal tabs use the final requested 20px
size. This preserves PR #1131's explicit 28px collapsed rail controls. The
standalone chevron remains because the user retracted the title-click request.
Header icons retain their 14px glyphs, matching tab-bar icon buttons.
