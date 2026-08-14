# Frontend UI Audit — TerminalMainContent

**File:** `src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/TerminalMainContent/index.tsx` (216 LOC)
**Date:** 2026-08-14
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                                           | Verdict          | Reason                                                                            | Suggested change |
| ---- | ------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------- | ---------------- |
| —    | No raw interactive or covered structural elements | keep with reason | The changed branch only selects whether an existing terminal component is mounted | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                              | Verdict          | Reason                                                                                                                                    | Suggested change |
| ---- | ---------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | No arbitrary Tailwind color values | keep with reason | The existing `backgroundColor` prop bridges the CodeMirror/terminal theme at the component boundary and was not introduced by this change | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                          | Verdict          | Reason                                        | Suggested change |
| ---- | ------------------------------ | ---------------- | --------------------------------------------- | ---------------- |
| —    | No new hardcoded size or color | keep with reason | The lifecycle refactor adds no visual literal | —                |

## D4 — Accessibility

| Line | Element                    | Verdict          | Reason                                                                                    | Suggested change |
| ---- | -------------------------- | ---------------- | ----------------------------------------------------------------------------------------- | ---------------- |
| —    | No new interactive element | keep with reason | Visibility controls resource mounting without changing the accessible interaction surface | —                |

## D5 — Visual Patterns Observed

- No new visual pattern; the component forwards host visibility to the existing terminal surface.

## Summary

- 0 fixes recommended
- 0 kept UI hits with documented reason (four no-hit checks documented)
- 0 abstract candidates (>= 3 occurrences)
