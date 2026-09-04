# NewChatHeaderActionsMenu UI audit

| Line                                                               | Element                        | Verdict          | Reason                                                                                                                                                             | Suggested change |
| ------------------------------------------------------------------ | ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `src/engines/ChatPanel/components/NewChatHeaderActionsMenu.tsx:48` | Ellipsis trigger               | keep with reason | Uses the same small tertiary, icon-only `Button` and ellipsis glyph as the session menu, with shared icon sizing and accessible menu/expanded labels               | None             |
| `src/engines/ChatPanel/components/NewChatHeaderActionsMenu.tsx:75` | Portal surface and positioning | keep with reason | Reuses `ActionMenuSurface`, shared panel/width/z-index tokens, and `getDropdownPanelStyle`; computed viewport coordinates belong in inline styles                  | None             |
| `src/engines/ChatPanel/components/NewChatHeaderActionsMenu.tsx:85` | UI controls submenu            | keep with reason | Reuses the session menu's `ActionSubmenu`, layer icon, keyboard owner, and left-opening flyout; no parallel menu implementation                                    | None             |
| `src/engines/ChatPanel/components/NewChatHeaderActionsMenu.tsx:96` | CLI update switch row          | keep with reason | The noninteractive row matches session UI settings rows and uses the shared labeled `Switch`; all 13 locales have the two new labels                               | None             |
| `src/engines/ChatPanel/index.tsx:564`                              | Placement after the plus menu  | keep with reason | Keeps the controls together in the existing toolbar slot so expanded and collapsed tab rows preserve their ordering; only the new-chat start page mounts this menu | None             |

Verdict totals: **0 fix**, **5 keep with reason**, **0 abstract**.

Reviewed D1–D5 within the new component and changed toolbar composition. No new arbitrary Tailwind values, hardcoded colors, or abstraction candidates were introduced. Existing session controls and unrelated workspace edits are outside this change.

Integrated stack verification is recorded in CreatorRefactorStack.md in the architecture-audit directory. Native Tauri interaction is not claimed; the checked-in screenshots are isolated creator layout fixtures with editor, icon, and domain-service leaves stubbed. They exercise the real creator view/scaffold and compiled production styles.
