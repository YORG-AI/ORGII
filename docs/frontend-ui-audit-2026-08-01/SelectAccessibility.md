# Frontend UI Audit — Select Accessibility Extension

**File:** `src/components/Select/index.tsx` (434 LOC), `src/components/LanguageSelector/index.tsx` (129 LOC)
**Date:** 2026-08-01
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                     | Element                        | Verdict          | Reason                                                                                                                                         | Suggested change |
| ------------------------ | ------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Select 398               | Search `<input>` inside Select | keep with reason | This is the internal editable search field of the DS Select itself; wrapping another Input would duplicate Select styling and focus ownership. | —                |
| LanguageSelector 114–125 | Shared `Select`                | keep with reason | Language selection delegates entirely to the canonical DS control and existing language atom.                                                  | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                            | Verdict          | Reason                                                    | Suggested change |
| ---- | -------------------------------- | ---------------- | --------------------------------------------------------- | ---------------- |
| —    | No new arbitrary Tailwind values | keep with reason | The accessibility extension introduces no visual styling. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value                          | Verdict          | Reason                                             | Suggested change |
| ---- | ------------------------------ | ---------------- | -------------------------------------------------- | ---------------- |
| —    | No new hardcoded size or color | keep with reason | Existing Select token/config values are unchanged. | —                |

## D4 — Accessibility

| Line                        | Element                    | Verdict          | Reason                                                                                                                                              | Suggested change |
| --------------------------- | -------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Select 341–353              | Focusable Select trigger   | keep with reason | The shared trigger now exposes `role=combobox`, localized `aria-label`, `aria-haspopup=listbox`, `aria-expanded`, tab focus, and keyboard handling. | —                |
| LanguageSelector 63–64, 123 | Accessible-name forwarding | keep with reason | The optional label is forwarded without changing existing call sites or language persistence.                                                       | —                |

## D5 — Visual Patterns Observed

- Accessible-name forwarding is centralized at Select, so onboarding and future settings surfaces do not need wrapper-specific ARIA workarounds.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates
