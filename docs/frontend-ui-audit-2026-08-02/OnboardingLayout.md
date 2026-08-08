# Frontend UI Audit — OnboardingLayout

**File:** `src/modules/shared/layouts/OnboardingLayout/index.tsx` (176 LOC)
**Date:** 2026-08-02
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line    | Element                 | Verdict          | Reason                                                                                                                      | Suggested change |
| ------- | ----------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 118–168 | Layout `<div>` elements | keep with reason | Shared structural layout owns drag regions and split/single-column composition; there is no interactive control to replace. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line    | Value                    | Verdict            | Reason                                                                                                                         | Suggested change                                                     |
| ------- | ------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| 19      | Custom onboarding shadow | keep with reason   | Component-local elevation is reused through `ONBOARDING_CARD_SHADOW` across every contained variant.                           | —                                                                    |
| 80, 138 | `z-[9999]`, `z-[100]`    | abstract candidate | Repo sweep found `z-[9999]` in seven unrelated surfaces; this is a shared layering-scale gap, not safe to change site-by-site. | Define named overlay/drag-region z-index tokens in a separate sweep. |
| 91–112  | Fixed onboarding bounds  | keep with reason   | The layout is the authoritative owner of its desktop container dimensions; values are paired across split and single variants. | —                                                                    |
| 138     | `h-[52px]`               | keep with reason   | Matches the native titlebar interaction height and is isolated to the shared drag region.                                      | —                                                                    |

## D3 — Hardcoded Sizes / Colors

| Line   | Value                              | Verdict          | Reason                                                                            | Suggested change |
| ------ | ---------------------------------- | ---------------- | --------------------------------------------------------------------------------- | ---------------- |
| 91–112 | 1400/840/560/420/400/320 px bounds | keep with reason | These are responsive component geometry, not ad-hoc visual styling at call sites. | —                |

## D4 — Accessibility

| Line     | Element      | Verdict          | Reason                                                                | Suggested change |
| -------- | ------------ | ---------------- | --------------------------------------------------------------------- | ---------------- |
| 127, 136 | Drag regions | keep with reason | Both are non-content interaction layers and explicitly `aria-hidden`. | —                |

## D5 — Visual Patterns Observed

- Sweep candidate: `z-[9999]` appears in seven unrelated overlays and should be normalized at configuration/token level in a dedicated change.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 1 abstract candidate
