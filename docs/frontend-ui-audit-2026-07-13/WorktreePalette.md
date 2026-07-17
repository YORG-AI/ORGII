# Frontend UI Audit — WorktreePalette

**File:** `src/scaffold/GlobalSpotlight/palettes/BranchPalette/index.tsx` (333 LOC)
**Date:** 2026-07-13
**Auditor:** ORGII implementation session

## D1 — Raw HTML vs Design System

| Line | Element                | Verdict          | Reason                                                                                                                              | Suggested change |
| ---- | ---------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 76   | Current-state `<span>` | keep with reason | The element is non-interactive status content inside the shared `SpotlightItemRow`; no button or input behavior is being recreated. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                      | Verdict            | Reason                                                                                                                            | Suggested change                                                            |
| ---- | -------------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 77   | Current-state pill classes | abstract (applied) | The same primary pill treatment was already duplicated by `SpotlightSearchBar` and `SpotlightPillBar`, making this the third use. | Added `SPOTLIGHT_CLASSES.primaryPill` and reused it in all three locations. |

## D3 — Hardcoded Sizes / Colors

| Line | Value           | Verdict          | Reason                                                                                                                        | Suggested change |
| ---- | --------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 77   | Badge text size | keep with reason | The badge uses `SPOTLIGHT_TOKENS.badgeFontSize`, the established Spotlight typography token, rather than a local pixel value. | —                |

## D4 — Accessibility

| Line | Element            | Verdict          | Reason                                                                                                                                    | Suggested change |
| ---- | ------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 76   | Current-state text | keep with reason | The visible `Current` text communicates selection in addition to the shared row's check icon; it is not an unlabeled interactive control. | —                |

## D5 — Visual Patterns Observed

- The primary contextual pill appeared in three Spotlight surfaces and is now centralized as `SPOTLIGHT_CLASSES.primaryPill`.
- Worktree rows continue to use the shared `SpotlightItemRow` layout, typography tokens, inline tag, selection state, pinned action, and keyboard navigation instead of introducing a custom row component.

## Summary

- 0 fixes remaining
- 3 findings kept with documented reason
- 1 abstract candidate applied
