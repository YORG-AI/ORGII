# AppUpdater UI audit

**Scope:** `src/scaffold/AppUpdater/index.tsx` and
`src/modules/MainApp/Settings/sections/GeneralSection.tsx`

The configured `frontend-ui-audit` skill file was unavailable, so this report
uses the repository's required audit table and design-system checks directly.

| Line                       | Element                              | Verdict          | Reason                                                                                                                                                 | Suggested change                                                                             |
| -------------------------- | ------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `AppUpdater/index.tsx:476` | Install confirmation modal           | fix              | The auto-download checkbox exposed an opt-out that contradicted the new always-download policy and added a redundant divider row.                      | Removed the entire checkbox/divider row; keep only the release decision and install actions. |
| `GeneralSection.tsx:398`   | App Update settings group            | fix              | The Automatic updates switch could still disable background downloads after the dialog control was removed.                                            | Removed the switch and retained channel selection, manual detection, and version display.    |
| `AppUpdater/index.tsx:488` | Modal action footer                  | keep with reason | Uses the shared `Button` component for skip, postpone, and primary install actions; variants and hierarchy remain consistent with the modal system.    | None.                                                                                        |
| `AppUpdater/index.tsx:521` | Update identity and description      | keep with reason | Uses the shared `AppMark`, semantic paragraph text, theme tokens, and existing spacing; no new arbitrary values or duplicated pattern were introduced. | None.                                                                                        |
| `GeneralSection.tsx:399`   | Channel, detection, and version rows | keep with reason | Uses `SectionRow`, `Select`, `Button`, and shared section styles, preserving the established Settings layout and accessible control labeling.          | None.                                                                                        |

## Summary

- Fix: 2
- Keep with reason: 3
- Abstract: 0
- Multi-file sweep candidates: 0
