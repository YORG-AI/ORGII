# Frontend UI Audit — SidebarGuideButton

**File:** `src/scaffold/NavigationSidebar/connectors/SidebarGuideButton.tsx` (300 LOC)
**Date:** 2026-08-02
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line    | Element                     | Verdict          | Reason                                                                                                                            | Suggested change |
| ------- | --------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 192     | Trigger wrapper `<div>`     | keep with reason | Ref-bearing layout wrapper required by the shared dropdown engine.                                                                | —                |
| 223–291 | Panel layout `<div>/<span>` | keep with reason | Non-interactive structure surrounds shared `DropdownPanel`, `DropdownItem`, `IconButton`, `ProgressBar`, and `Avatar` primitives. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value | Verdict          | Reason                                                                                 | Suggested change |
| ---- | ----- | ---------------- | -------------------------------------------------------------------------------------- | ---------------- |
| —    | None  | keep with reason | Width, spacing, icon size, item height, and panel gap use dropdown/workstation tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value | Verdict          | Reason                                                             | Suggested change |
| ---- | ----- | ---------------- | ------------------------------------------------------------------ | ---------------- |
| —    | None  | keep with reason | Status colors and geometry use semantic classes and design tokens. | —                |

## D4 — Accessibility

| Line    | Element       | Verdict          | Reason                                                                                                   | Suggested change |
| ------- | ------------- | ---------------- | -------------------------------------------------------------------------------------------------------- | ---------------- |
| 193–208 | Guide trigger | keep with reason | Shared button exposes localized label, menu ownership, and expanded state.                               | —                |
| 46–77   | Task rows     | keep with reason | Shared menu items provide keyboard semantics; completion/current states remain visually distinct.        | —                |
| 211–294 | Guide panel   | keep with reason | Panel has localized menu label, progress has an accessible value label, and icon-only actions are named. | —                |

## D5 — Visual Patterns Observed

- No new local duplicate: the guide consistently uses the existing dropdown action-row pattern.

## Summary

- 0 fixes recommended
- 7 kept with documented reason
- 0 abstract candidates
