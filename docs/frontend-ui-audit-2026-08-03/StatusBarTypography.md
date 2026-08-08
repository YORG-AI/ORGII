# Frontend UI Audit — StatusBarTypography

**Files:** `src/modules/WorkStation/shared/StatusBar/*.tsx`, `src/modules/WorkStation/shared/StatusBar/statusBarTokens.ts`, `src/components/DiffStatsBadge/index.tsx`
**Date:** 2026-08-03
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                                  | Element                              | Verdict          | Reason                                                                                                                                                                       | Suggested change |
| ------------------------------------- | ------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `StatusBarBase.tsx:126`               | `<button>` inside `StatusBarButton`  | keep with reason | This is the status-bar design-system primitive itself; it owns status-bar sizing, variants, disabled state, tooltip forwarding, and accessible naming.                       | —                |
| `GitSyncStatusMenu.tsx:241,266,293`   | Git action menu `<button>` rows      | keep with reason | Rows use shared dropdown tokens, `role="menuitem"`, visible labels, and menu-specific disabled behavior; the general Button component does not cover this menu-row contract. | —                |
| `PortsStatusMenu.tsx:118,130,143,371` | Port action/menu `<button>` controls | keep with reason | These are compact menu-row actions with distinct copy/open/stop behavior and established dropdown styling; each has a visible or explicit accessible name.                   | —                |
| `PortsStatusMenu.tsx:312`             | Port filter `<input>`                | keep with reason | This is embedded in the shared dropdown search container and uses the dropdown search token contract; replacing it independently would break the compact menu composition.   | —                |
| `CiStatusMenu.tsx:158,332,341`        | CI menu action `<button>` controls   | keep with reason | The controls are menu-local icon/action rows with accessible labels and shared dropdown styling.                                                                             | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                       | Value                                  | Verdict                  | Reason                                                                                                                                                                                  | Suggested change                                                                                           |
| -------------------------- | -------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `StatusBarRenderer.tsx:28` | `bg-[var(--cm-editor-background,...)]` | fix candidate (deferred) | Folder-wide sweep found a project-owned editor background variable outside the typography change. It should not be changed site-by-site in this single-responsibility typography patch. | Map the project-owned variable in Tailwind or fold it into the matching surface token in a separate sweep. |

## D3 — Hardcoded Sizes / Colors

| Line                                            | Value                           | Verdict                  | Reason                                                                                                                                                                           | Suggested change                                                      |
| ----------------------------------------------- | ------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `statusBarTokens.ts:20`                         | status-bar 11px type scale      | fix (completed)          | The previous local `text-[11px]` duplicated the global workstation secondary typography role.                                                                                    | `STATUS_BAR_TYPOGRAPHY.root` now derives from `TYPOGRAPHY.secondary`. |
| `statusBarTokens.ts:71`                         | extension item 11px/line-height | fix (completed)          | Extension items repeated the base bar typography literal.                                                                                                                        | Extension items now compose `STATUS_BAR_TYPOGRAPHY.root`.             |
| `EditorStatusBar.tsx:620`                       | language-service panel 13px     | fix (completed)          | The status-bar-owned dropdown repeated the existing dropdown item font size.                                                                                                     | Reuse `DROPDOWN_ITEM.fontSizeClass`.                                  |
| `BrowserStatusBar.tsx:118`                      | `max-w-[240px]`                 | fix candidate (deferred) | `max-w-60` is an equivalent spacing token, but width cleanup is unrelated to the requested typography lifecycle.                                                                 | Replace in a focused status-bar sizing cleanup.                       |
| `EditorStatusBar.tsx:474`                       | `max-w-[200px]`                 | keep with reason         | The truncation cap has no exact standard Tailwind spacing equivalent; 192px or 208px would change the commit-author allocation.                                                  | —                                                                     |
| `DiffStatsBadge/diffStatsBadgeHelpers.ts:16-18` | named 11/12/13px scale          | keep with reason         | Pixel values are isolated behind the component's `size` API and intentionally match the established diff-viewer type scale. Callers do not repeat arbitrary font-size utilities. | —                                                                     |

## D4 — Accessibility

| Line                      | Element                    | Verdict          | Reason                                                                                                                                             | Suggested change |
| ------------------------- | -------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `StatusBarBase.tsx:126`   | `StatusBarButton`          | keep with reason | Visible children provide a name; icon-only uses supply `ariaLabel` or `title`, which is forwarded to `aria-label`.                                 | —                |
| `EditorStatusBar.tsx:608` | click-away overlay `<div>` | keep with reason | The overlay is a pointer-dismiss backdrop, not the primary interactive control; the language-services trigger remains a keyboard-focusable button. | —                |
| Git/ports/CI menus        | menu controls              | keep with reason | Menu action buttons have visible labels or explicit accessible names and retain native keyboard semantics.                                         | —                |

## D5 — Visual Patterns Observed

- Pattern: 11px status-bar text with normal/medium roles and tabular numeric values — previously repeated across Editor, Browser, Project, Git Sync, CI, and Ports status surfaces; now abstracted by `STATUS_BAR_TYPOGRAPHY`, `StatusBarLabel`, and `StatusBarText` semantic props.
- Pattern: normal-weight diff statistics in the status bar — now expressed through the shared `DiffStatsBadge weight="normal"` API while every existing consumer keeps the backwards-compatible medium default.

## Summary

- 4 fixes completed
- 8 kept with documented reason
- 2 deferred fix candidates outside the typography scope
- 2 repeated typography patterns abstracted
