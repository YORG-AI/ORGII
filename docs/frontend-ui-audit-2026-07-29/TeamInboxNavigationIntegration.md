# Frontend UI Audit — Team Inbox Navigation Integration

**Files:** `src/engines/ChatPanel/ChatPanelTabBar.tsx`, `src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/**`, `src/scaffold/NavigationSidebar/connectors/workstationSidebarMenuItems.tsx`
**Date:** 2026-07-29
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                                 | Element                         | Verdict          | Reason                                                                                                                                        | Suggested change |
| ------------------------------------ | ------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `workstationSidebarMenuItems.tsx:88` | Team Inbox `NavigationMenuItem` | keep with reason | The entry uses the sidebar's canonical menu-item model and `NavigationSidebar` renderer rather than introducing a parallel button.            | —                |
| `ChatPanelTabBar.tsx:660`            | Session handoff menu action     | keep with reason | The action is hosted by the existing tab context-menu design-system surface and converges on the same handoff request state as drag-and-drop. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                   | Verdict          | Reason                                                                                                  | Suggested change |
| ---- | ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | No new arbitrary values | keep with reason | The integration adds state, labels, icons, and routing only; no visual value bypasses the token system. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                                 | Value                          | Verdict          | Reason                                                                                                        | Suggested change |
| ------------------------------------ | ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------- | ---------------- |
| `workstationSidebarMenuItems.tsx:95` | Existing unread badge renderer | keep with reason | The badge reuses the menu renderer's semantic status styling; the integration changes only its bounded count. | —                |

## D4 — Accessibility

| Line                                      | Element            | Verdict          | Reason                                                                                                               | Suggested change |
| ----------------------------------------- | ------------------ | ---------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `workstationSidebarMenuItems.tsx:97`      | Unread-count badge | keep with reason | It exposes an explicit accessible label and caps the visual count at `99+` without changing the spoken count.        | —                |
| `sidebarConnector.menuItemRouting.ts:137` | Team Inbox route   | keep with reason | The route is activated by the already keyboard-accessible `NavigationMenuItem`; no mouse-only handler is introduced. | —                |

## D5 — Visual Patterns Observed

- Team Inbox uses the existing sidebar menu, ChatPanel tab, context-menu, badge, and localization patterns.
- No third independent implementation or new abstraction candidate was introduced.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates
