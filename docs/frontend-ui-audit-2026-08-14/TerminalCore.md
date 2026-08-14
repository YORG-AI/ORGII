# Frontend UI Audit — TerminalCore

**File:** `src/engines/TerminalCore/index.tsx` (440 LOC)
**Date:** 2026-08-14
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                                           | Verdict          | Reason                                                                                                                 | Suggested change |
| ---- | ------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | No raw interactive or covered structural elements | keep with reason | The changed surface composes existing terminal and placeholder components; xterm host internals are outside this audit | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                              | Verdict          | Reason                                                  | Suggested change |
| ---- | ---------------------------------- | ---------------- | ------------------------------------------------------- | ---------------- |
| —    | No arbitrary Tailwind color values | keep with reason | The lifecycle refactor adds no class-level token bridge | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                          | Verdict          | Reason                                    | Suggested change |
| ---- | ------------------------------ | ---------------- | ----------------------------------------- | ---------------- |
| —    | No new hardcoded size or color | keep with reason | The refactor changes mount ownership only | —                |

## D4 — Accessibility

| Line | Element                    | Verdict          | Reason                                                                 | Suggested change |
| ---- | -------------------------- | ---------------- | ---------------------------------------------------------------------- | ---------------- |
| —    | No new interactive element | keep with reason | Visible and hidden states continue to use existing semantic components | —                |

## D5 — Visual Patterns Observed

- No new visual pattern; the change replaces retained hidden terminal surfaces with one active mounted surface.

## Summary

- 0 fixes recommended
- 0 kept UI hits with documented reason (four no-hit checks documented)
- 0 abstract candidates (>= 3 occurrences)
