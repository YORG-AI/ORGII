# Frontend UI Audit — GitHubWorkItemsSurface Phase 1

**Files:**

- `src/modules/MainApp/WorkManagement/GitHubWorkItemsSurface.tsx` (2066 LOC after Phase 1)
- `src/modules/MainApp/WorkManagement/CreateIssueModal.tsx` (115 LOC)
- `src/modules/MainApp/WorkManagement/githubWorkItemsSearchQuery.ts` (185 LOC, non-visual)

**Date:** 2026-07-20
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line                   | Element                                       | Verdict          | Reason                                                                                                                                                            | Suggested change |
| ---------------------- | --------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CreateIssueModal.tsx` | modal shell / title input / repository select | keep with reason | Uses the shared `Modal`, `Input`, and `Select` components and preserves the original form composition.                                                            | —                |
| `CreateIssueModal.tsx` | body textarea                                 | keep with reason | The repository has no matching multiline shared input in this flow; the semantic textarea uses design-system token classes and preserves native editing behavior. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line       | Value                               | Verdict          | Reason                                                                                                      | Suggested change                                        |
| ---------- | ----------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| modal leaf | compact typography / minimum height | keep with reason | Existing modal form dimensions were moved unchanged; colors and borders use semantic design-system classes. | Consider only in a global multiline form-control sweep. |

## D3 — Hardcoded Sizes / Colors

| Line       | Value                        | Verdict          | Reason                                                                                                                    | Suggested change |
| ---------- | ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| modal leaf | modal width / select z-index | keep with reason | Values preserve Modal/dropdown overlay geometry and are behavioral overlay configuration rather than ad-hoc page styling. | —                |

## D4 — Accessibility

| Line       | Element               | Verdict          | Reason                                                                                                       | Suggested change |
| ---------- | --------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ | ---------------- |
| modal leaf | repository field      | keep with reason | The repository selector remains associated with visible label text via the semantic wrapping label.          | —                |
| modal leaf | create/cancel actions | keep with reason | Modal owns dialog semantics and action focus; create is disabled until a repository and trimmed title exist. | —                |

## D5 — Visual Patterns Observed

- Phase 1 moves the create form without changing visual markup, i18n labels, or overlay behavior.
- The search-query extraction is pure and non-visual; no shared visual primitive is introduced.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 immediate abstract candidates
