# Floating Side Chat launcher

## Scope

Audited the new global floating Side Chat trigger for design-system reuse, layering, accessibility, responsive placement, surface scoping, and duplication with the existing Side Chat window.

## Findings

| Line                                                              | Element                             | Verdict          | Reason                                                                                                                                                                       | Suggested change                                                                                                             |
| ----------------------------------------------------------------- | ----------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/engines/ChatPanel/SideChat/index.tsx:116`                    | Floating Side Chat trigger          | fix              | The existing global Side Chat window had menu-only entry points and no persistent in-context affordance.                                                                     | Keep the launcher visible on surfaces that carry no chat of their own.                                                       |
| `src/engines/ChatPanel/SideChat/index.tsx:123`                    | Circular action control             | abstract         | The trigger uses the shared `Button` component and workstation icon-size token instead of defining raw button behavior or local dimensions.                                  | Continue using the shared button variants for future launcher states.                                                        |
| `src/engines/ChatPanel/SideChat/index.tsx:131`                    | Accessible name and popup semantics | keep with reason | The icon-only control has a translated title/accessible name, native button keyboard behavior, and declares that it opens a dialog-like panel.                               | Add focus restoration only if the Side Chat window later adopts modal focus management.                                      |
| `src/engines/ChatPanel/SideChat/index.tsx:81`                     | Bottom-right floating placement     | keep with reason | Standard spacing-scale classes place the action above the full pane host; the existing pointer-event isolation prevents the overlay from blocking the workbench.             | Revisit placement when collision-aware multi-window docking is designed.                                                     |
| `src/engines/ChatPanel/SideChat/index.tsx:149`                    | Surface scoping of the trigger      | fix              | An always-on launcher duplicated an affordance the surface underneath already owned: the launchpad _is_ a composer, and a session tab already shows that session's composer. | Keep the gate in `sideChatLauncherVisibility.ts` so the rule stays one testable predicate rather than inline JSX conditions. |
| `src/engines/ChatPanel/SideChat/sideChatLauncherVisibility.ts:17` | Hidden-surface list                 | keep with reason | An explicit deny-list of `start-page` and `session` means a newly added tab type shows the launcher by default — the safe direction, since a chat-less surface is the norm.  | Revisit only if a future tab type ships its own composer.                                                                    |
| `src/engines/ChatPanel/SideChat/index.tsx:145`                    | Active-surface subscription         | abstract         | Reads the primitive-valued `activeChatPanelTabTypeAtom` rather than the whole active-tab object, so title and payload patches do not re-render the launcher.                 | Reuse this selector for any other chrome that branches on surface kind.                                                      |

## Summary

- Fix: 2
- Keep with reason: 3
- Abstract: 3
- Remaining cross-file sweep candidates: 0

The configured `frontend-ui-audit` skill file was unavailable in both the referenced user-global and workspace locations. This report follows the repository's documented audit table convention and covers the changed UI surface directly.
