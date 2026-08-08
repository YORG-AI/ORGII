# Frontend UI Audit — NotificationLifecycle

**Files:**

- `src/modules/MainApp/Settings/renderer/slots/NotificationsAdvancedBlocks.tsx`
- `src/modules/MainApp/Settings/renderer/slots/NotificationsMasterToggleRow.tsx`

**Date:** 2026-07-30
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                                      | Element                      | Verdict          | Reason                                                                                                       | Suggested change |
| ----------------------------------------- | ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------ | ---------------- |
| `NotificationsAdvancedBlocks.tsx:150-261` | Notification settings groups | keep with reason | Uses the canonical `SectionContainer`, `SectionRow`, `Switch`, `Slider`, and `Button` primitives throughout. | —                |
| `NotificationsMasterToggleRow.tsx:9`      | Master notification toggle   | keep with reason | Uses the shared `Switch` and the settings atom instead of introducing a local checkbox pattern.              | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                                      | Value                          | Verdict          | Reason                                                                                                                                    | Suggested change |
| ----------------------------------------- | ------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `NotificationsAdvancedBlocks.tsx:160`     | `w-[160px]`                    | keep with reason | The fixed slider track width is an optical control dimension inside a responsive `max-w-full` wrapper; there is no matching design token. | —                |
| `NotificationsAdvancedBlocks.tsx:207-214` | Permission status text classes | keep with reason | Uses existing spacing and semantic text tokens; no raw colors were introduced.                                                            | —                |

## D3 — Hardcoded Sizes / Colors

| Line                                  | Value               | Verdict          | Reason                                                                                                                    | Suggested change |
| ------------------------------------- | ------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `NotificationsAdvancedBlocks.tsx:160` | 160 px slider width | keep with reason | Keeps the volume control stable across conditional rows while `max-w-full` prevents overflow on narrow settings surfaces. | —                |

## D4 — Accessibility

| Line                                      | Element                                      | Verdict          | Reason                                                                                                                       | Suggested change |
| ----------------------------------------- | -------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `NotificationsAdvancedBlocks.tsx:151-260` | Settings controls                            | keep with reason | Every control is paired with a localized `SectionRow` label and preserves the shared primitives' keyboard behavior.          | —                |
| `NotificationsAdvancedBlocks.tsx:188-228` | Permission status and system-settings action | keep with reason | Disabled/requesting state is exposed on the switch and the status remains visible as localized text rather than color alone. | —                |

## D5 — Visual Patterns Observed

- Notification categories share one data-driven `SectionRow` and `Switch` pattern.
- Sound, system permission, dock badge, and test actions reuse the existing Settings section hierarchy.
- No visual pattern reached the three-independent-implementation abstraction threshold.

## Summary

- 0 fixes recommended
- 7 kept with documented reason
- 0 abstract candidates
