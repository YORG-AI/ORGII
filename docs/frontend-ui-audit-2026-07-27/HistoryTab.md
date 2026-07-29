# Frontend UI Audit — HistoryTab

**File:** `src/modules/ProjectManager/WorkItems/components/WorkItemContent/HistoryTab.tsx` (291 LOC)
**Date:** 2026-07-27
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                         | Verdict          | Reason                                                                                                                             | Suggested change                                                    |
| ---- | ------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 155  | `<details>` activity disclosure | keep with reason | Native disclosure semantics cover this compact, text-only history event; the design system has no equivalent disclosure component. | —                                                                   |
| 156  | `<summary>` activity trigger    | keep with reason | It is the semantic trigger paired with the native `<details>` element and retains keyboard behavior without custom handlers.       | —                                                                   |
| 184  | Comment submit action           | fix              | The thread composer should use the shared `Button` and composer shell instead of maintaining bespoke button and card chrome.       | Implemented with `Button` inside `ComposerShell variant="comment"`. |

## D2 — Arbitrary Tailwind Value vs Token

| Line    | Value                           | Verdict          | Reason                                                                                                                                                             | Suggested change |
| ------- | ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 204–205 | User avatar color CSS variables | keep with reason | The background can be a runtime user color; the CSS variables are token fallbacks passed through the `Avatar` API rather than duplicated Tailwind color utilities. | —                |

## D3 — Hardcoded Sizes / Colors

| Line    | Value                                                       | Verdict          | Reason                                                                                                                                    | Suggested change |
| ------- | ----------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 190–222 | 16px icon, 28px avatar/editor minimum, 120px editor maximum | keep with reason | These are component API dimensions: 28px matches the design-system small action height, while the maximum bounds the auto-growing editor. | —                |
| 257     | `text-[13px]` activity heading                              | keep with reason | This existing compact section-heading size sits deliberately between the 12px and 14px text tokens and matches adjacent thread metadata.  | —                |

## D4 — Accessibility

| Line    | Element                 | Verdict          | Reason                                                                                                                 | Suggested change |
| ------- | ----------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 184–196 | Icon-only submit button | keep with reason | The design-system button has both a localized `title` and `aria-label`; its disabled and loading states remain native. | —                |
| 215–227 | Rich comment editor     | keep with reason | The editor retains a localized placeholder and existing Command/Ctrl+Enter submit behavior.                            | —                |

## D5 — Visual Patterns Observed

- Pattern: avatar-adjacent text composer with an inline circular submit action. The shared `ComposerShell` now owns the border, background, radius, hover, and focus states; this avoids a new one-off thread card.

## Summary

- 1 fix recommended and implemented
- 7 kept with documented reason
- 0 abstract candidates
