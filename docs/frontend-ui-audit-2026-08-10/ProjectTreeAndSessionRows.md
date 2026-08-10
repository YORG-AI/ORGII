# Frontend UI Audit - Project Tree And Session Rows

## Scope

`ProjectTreePage`, `SessionJourneySnapshot`, and sidebar session-row status markers.

## D1 - Raw HTML vs Design System

| Line                         | Element                 | Verdict          | Reason                                                                                                            | Suggested change |
| ---------------------------- | ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ProjectTreePage.tsx`        | Tree task/fork actions  | keep with reason | The tree already uses compact native buttons for row-level navigation; the new actions use that existing pattern. | None.            |
| `SessionJourneySnapshot.tsx` | Selected task/fork card | keep with reason | Selection reuses the existing Journey card border and semantic primary tokens.                                    | None.            |

## D2 - Arbitrary Tailwind Value vs Token

| Line                   | Value                                | Verdict          | Reason                                                                      | Suggested change |
| ---------------------- | ------------------------------------ | ---------------- | --------------------------------------------------------------------------- | ---------------- |
| `statusIndicators.tsx` | `primary-6`, `success-6`, `danger-6` | keep with reason | These are existing semantic tokens for active, completed, and error status. | None.            |

## D3 - Hardcoded Sizes / Colors

| Line                  | Value          | Verdict          | Reason                                        | Suggested change |
| --------------------- | -------------- | ---------------- | --------------------------------------------- | ---------------- |
| `ProjectTreePage.tsx` | 14px task icon | keep with reason | Matches every existing Project Tree row icon. | None.            |

## D4 - Accessibility

| Line                   | Element                   | Verdict          | Reason                                                        | Suggested change |
| ---------------------- | ------------------------- | ---------------- | ------------------------------------------------------------- | ---------------- |
| `statusIndicators.tsx` | Session status dots       | keep with reason | Each persistent dot has an explicit accessible state label.   | None.            |
| `ProjectTreePage.tsx`  | Task/fork Journey actions | keep with reason | They remain visible labelled buttons, not icon-only controls. | None.            |

## D5 - Visual Patterns Observed

- No new visual pattern was introduced; task and fork rows use the existing Project Tree hierarchy and action styling.
- No sweep candidate was found. The status-dot sweep found a single production session-row builder.

## Summary

- 0 fixes recommended
- 5 kept with documented reason
- 0 abstract candidates

**Note:** the configured `frontend-ui-audit` skill file was unavailable; this report follows the repository audit format.
