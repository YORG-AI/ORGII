# Frontend UI Audit — SessionCreator ChatPanel

**File:** `src/features/SessionCreator/variants/ChatPanel/index.tsx` (1139 LOC)
**Date:** 2026-07-22
**Auditor:** Codex worktree data-flow fix

## D1 — Raw HTML vs Design System

| Line | Element                      | Verdict          | Reason                                                                                                                         | Suggested change                                                                        |
| ---- | ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 937  | Full-width launch `<button>` | fix candidate    | The control is a labelled action whose behavior is covered by the DS `Button`. It predates this data-flow change.              | Convert in a dedicated UI cleanup so fullscreen layout parity can be visually verified. |
| 970  | Share-screen `<button>`      | fix candidate    | This is a labelled icon action that appears compatible with a compact outlined DS `Button`. It predates this data-flow change. | Convert in a dedicated UI cleanup and verify the dashed-pill treatment.                 |
| 1093 | Hidden file `<input>`        | keep with reason | Native file selection requires an input element and the DS input components do not cover hidden multi-file pickers.            | —                                                                                       |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                                                 | Verdict          | Reason                                     | Suggested change |
| ---- | ----------------------------------------------------- | ---------------- | ------------------------------------------ | ---------------- |
| —    | No project CSS-variable or raw-color arbitrary values | keep with reason | Existing classes use project color tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line     | Value                         | Verdict  | Reason                                                                                                                                   | Suggested change                                                       |
| -------- | ----------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 941, 972 | `text-[13px]` / `text-[12px]` | abstract | Repository sweep found the same literals in 205 and 242 files; changing these two call sites alone would create inconsistent typography. | Define semantic compact/body typography utilities in a separate sweep. |

## D4 — Accessibility

| Line     | Element           | Verdict          | Reason                                                                                                                | Suggested change |
| -------- | ----------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 937, 970 | Labelled buttons  | keep with reason | Both controls have visible accessible names and native keyboard behavior.                                             | —                |
| 1093     | Hidden file input | keep with reason | It is programmatically activated by the existing attachment control and is removed from visual/tab flow via `hidden`. | —                |

## D5 — Visual Patterns Observed

- Pattern: repository-wide 12px/13px typography literals are an abstract candidate for semantic typography tokens.
- No visual pattern was introduced by the worktree selection-state changes.

## Summary

- 2 fixes recommended (pre-existing, deferred from this data-flow fix)
- 4 kept with documented reason
- 1 abstract candidate (>= 3 occurrences)
