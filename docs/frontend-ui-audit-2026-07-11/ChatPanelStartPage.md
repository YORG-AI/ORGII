# Frontend UI Audit — ChatPanelStartPage

**Files:** `src/engines/ChatPanel/ChatPanelStartPage.tsx`, `src/engines/ChatPanel/ChatPanelEmptyContent.tsx`, `src/engines/ChatPanel/index.tsx`
**Date:** 2026-07-11
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                         | Element                | Verdict          | Reason                                                                                                                                                                                                          | Suggested change |
| ---------------------------- | ---------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ChatPanelStartPage.tsx:243` | `<button>` action card | keep with reason | The existing start-page action primitive is a full-width semantic button with custom pill layout and hover affordances. The update action reuses this primitive rather than introducing another button pattern. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                             | Value                            | Verdict          | Reason                                                                                                                                                                    | Suggested change |
| -------------------------------- | -------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ChatPanelStartPage.tsx:426-427` | `max-w-[600px]`, `max-w-[400px]` | keep with reason | These existing widths define the narrow action-list and expanded trend-layout bounds. The new row inherits the existing container without adding another arbitrary value. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                             | Value                            | Verdict          | Reason                                                                                                                                                        | Suggested change |
| -------------------------------- | -------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ChatPanelStartPage.tsx:255`     | `text-[13px]`                    | keep with reason | This is the established compact label size for every start-page action; the update label reuses it for visual parity.                                         | —                |
| `ChatPanelStartPage.tsx:239-240` | `text-primary-6`                 | keep with reason | The update action intentionally applies the existing primary foreground token to its label and icon only, giving it emphasis without introducing a raw color. | —                |
| `ChatPanelStartPage.tsx:402`     | `size={13}`, `strokeWidth={1.8}` | keep with reason | The download icon matches every neighboring quick-action icon exactly, preserving optical weight and alignment.                                               | —                |

## D4 — Accessibility

| Line                             | Element                      | Verdict          | Reason                                                                                                                                                            | Suggested change |
| -------------------------------- | ---------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ChatPanelStartPage.tsx:243-264` | Install latest update action | keep with reason | The control is a native button, has visible localized text as its accessible name, and retains the shared focus and click semantics of the action-card primitive. | —                |

## D5 — Visual Patterns Observed

- The full-width quick-action row is reused through `StartPageActionCard`; no new visual variant was introduced.
- The update action uses the shared updater availability state, matching the sidebar update button and avoiding a second source of truth.
- The localized update label is present in every supported locale.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates (>= 3 occurrences)
