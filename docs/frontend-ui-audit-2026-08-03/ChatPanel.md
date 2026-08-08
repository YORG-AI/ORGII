# Frontend UI Audit — ChatPanel

**File:** `src/engines/ChatPanel/index.tsx` (changed connector surface)
**Date:** 2026-08-03
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element               | Verdict          | Reason                                                                                                                                                      | Suggested change |
| ---- | --------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | Add-ORG intent wiring | keep with reason | The change subscribes to and clears transient navigation intent; it renders no new element and leaves the existing `ChatPanelStartPage` composition intact. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                   | Verdict          | Reason                             | Suggested change |
| ---- | ----------------------- | ---------------- | ---------------------------------- | ---------------- |
| —    | None in changed surface | keep with reason | No class or style value was added. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                   | Verdict          | Reason                        | Suggested change |
| ---- | ----------------------- | ---------------- | ----------------------------- | ---------------- |
| —    | None in changed surface | keep with reason | No visual constant was added. | —                |

## D4 — Accessibility

| Line | Element                | Verdict          | Reason                                                                                                                                                | Suggested change |
| ---- | ---------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 116  | One-shot intent setter | keep with reason | Manual creator selection clears the guide preset before navigation, so a stale programmatic focus request cannot alter a later ordinary Add ORG form. | —                |

## D5 — Visual Patterns Observed

- Pattern: top-level panel connectors pass runtime intent to the owning creator without duplicating rendered form state.

## Summary

- 0 fixes recommended
- 4 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
