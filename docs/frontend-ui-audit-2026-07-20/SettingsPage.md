# Frontend UI Audit — Settings Page Refactor

**Files:**

- `src/modules/MainApp/Settings/index.tsx` (72 LOC)
- `src/modules/MainApp/Settings/components/SettingsMainContent.tsx` (56 LOC)

**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line                            | Element                               | Verdict          | Reason                                                                                                                                             | Suggested change |
| ------------------------------- | ------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `index.tsx:50–68`               | settings root `<div>`                 | keep with reason | These are non-interactive route/layout hosts; loading uses the shared `Placeholder` component.                                                     | —                |
| `SettingsMainContent.tsx:26–54` | responsive header/content composition | keep with reason | Tabs, header, scroll behavior, and responsive width continue to use `ResponsiveContainer`, `InternalHeader`, `TabPill`, and `ScrollFadeContainer`. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                               | Value                   | Verdict          | Reason                                                                                                                                 | Suggested change |
| ---------------------------------- | ----------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `SettingsMainContent.tsx:31,44,46` | `DETAIL_PANEL_TOKENS.*` | keep with reason | Header, scroll, and content widths use the canonical detail-panel token source; no arbitrary color or CSS variable utility is present. | —                |

## D3 — Hardcoded Sizes / Colors

| Line            | Value | Verdict          | Reason                                                               | Suggested change |
| --------------- | ----- | ---------------- | -------------------------------------------------------------------- | ---------------- |
| all changed TSX | none  | keep with reason | The refactor introduces no pixel-literal sizing or raw color values. | —                |

## D4 — Accessibility

| Line                            | Element              | Verdict          | Reason                                                                                  | Suggested change |
| ------------------------------- | -------------------- | ---------------- | --------------------------------------------------------------------------------------- | ---------------- |
| `SettingsMainContent.tsx:28–42` | settings tabs        | keep with reason | Keyboard and accessible tab semantics remain owned by the existing `TabPill` component. | —                |
| `index.tsx:51–55`               | lazy subpage loading | keep with reason | Loading remains visible through the shared detail-panel `Placeholder`.                  | —                |

## D5 — Visual Patterns Observed

- The extracted main-content component reuses the same detail-panel shell already used by Settings; it does not create a competing visual pattern.
- No new repeated visual implementation or shared-component candidate was introduced.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates
