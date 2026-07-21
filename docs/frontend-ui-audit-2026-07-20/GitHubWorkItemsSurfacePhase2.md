# Frontend UI Audit — GitHubWorkItemsSurface Phase 2

**Files:**

- `src/modules/MainApp/WorkManagement/GitHubWorkItemsSurface.tsx` (1627 LOC after Phase 2)
- `src/modules/MainApp/WorkManagement/GitHubWorkItemRows.tsx` (267 LOC)
- `src/modules/MainApp/WorkManagement/githubManagedItemModel.ts` (200 LOC, non-visual)

**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line     | Element                             | Verdict          | Reason                                                                                                                                                                                | Suggested change |
| -------- | ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| row leaf | issue/PR primary `<button>`         | keep with reason | The full-width multi-column title/metadata hit area is the semantic row action; shared `Button` does not cover this layout, while `GitHubWorkItemRow` owns the surrounding structure. | —                |
| row leaf | dropdown action `<button>` elements | keep with reason | Uses the established `DROPDOWN_CLASSES.menuActionItem` command-menu pattern already documented for this audit batch.                                                                  | —                |
| row leaf | add/more actions                    | keep with reason | Uses shared `Button` and `Dropdown` components with existing variants and accessible labels.                                                                                          | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line     | Value                                                 | Verdict          | Reason                                                                                                                 | Suggested change                                                |
| -------- | ----------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| row leaf | compact `text-[10px]` / `text-[11px]` / `text-[13px]` | keep with reason | Values preserve the existing dense GitHub list hierarchy and were moved unchanged; no project color token is bypassed. | Consider only in a broader compact-list typography token sweep. |

## D3 — Hardcoded Sizes / Colors

| Line        | Value                         | Verdict          | Reason                                                                                                                                     | Suggested change |
| ----------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| issue label | dynamic background/text color | keep with reason | GitHub supplies arbitrary label colors at runtime; calculated contrast text is required and cannot be represented by a fixed design token. | —                |
| row leaf    | `min-w-[180px]`, `px-[7px]`   | keep with reason | Existing dropdown geometry and label-chip optical spacing are preserved; these are component-local alignment values.                       | —                |

## D4 — Accessibility

| Line     | Element                 | Verdict          | Reason                                                                                                                         | Suggested change |
| -------- | ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| row leaf | issue/PR primary action | keep with reason | Both native buttons have explicit contextual `aria-label` values including item number and title.                              | —                |
| row leaf | add/more actions        | keep with reason | Add actions have contextual labels; the menu trigger exposes `aria-expanded` and the dropdown owns keyboard behavior.          | —                |
| row leaf | click-stopping `<span>` | keep with reason | The span is not an independent action; it only prevents the nested accessible dropdown trigger from activating the row action. | —                |
| row leaf | avatar image            | keep with reason | Empty alt keeps the avatar decorative while the author is present as text and title metadata.                                  | —                |

## D5 — Visual Patterns Observed

- Issue and PR rows intentionally share `GitHubWorkItemRow` while retaining domain-specific content and actions.
- Dynamic GitHub label chips remain local to issue rows; no third independent implementation was found in this refactor scope.

## Summary

- 0 fixes recommended
- 10 kept with documented reason
- 0 abstract candidates
