# Session sidebar ordering UI audit

| Line                                                                                                      | Element                  | Verdict          | Reason                                                                                                                      | Suggested change |
| --------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/scaffold/NavigationSidebar/connectors/SessionFilterButton.tsx:387`                                   | Sort trigger and submenu | keep with reason | Reuses DropdownItem, DropdownPanel, shared submenu positioning and keyboard/click handling; all 13 locales supplied         | None             |
| `src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/useSessionSidebarOrdering.tsx:234` | Unpin drop target        | keep with reason | Non-clickable pointer destination use themed border/text tokens; existing row pin actions remain available without dragging | None             |
| `src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/useSessionSidebarOrdering.tsx:256` | Insertion line           | keep with reason | Pointer-transparent, aria-hidden overlay uses theme accent; computed coordinates must track actual row bounds               | None             |
| `src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/index.tsx:623`                     | Row wrapper composition  | keep with reason | Preserves existing row wrapper and reference drag source; no duplicate button or navigation handler                         | None             |

Verdict totals: **0 fix**, **4 keep with reason**, **0 abstract**.

Visual verification: DOM integration tests cover insertion-line presence and cleanup. No desktop control, screenshot capture, or real Tauri visual check was performed, per the user's computer-use preference. Theme contrast, actual pointer geometry, scrolling during drag, and narrow-window layout remain unverified in the real app.
