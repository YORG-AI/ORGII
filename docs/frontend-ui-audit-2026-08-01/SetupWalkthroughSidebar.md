# Frontend UI Audit — SetupWalkthroughSidebar

**File:** `src/modules/SetupWalkthrough/components/SetupWalkthroughSidebar.tsx` (62 LOC)
**Date:** 2026-08-01
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line  | Element                           | Verdict          | Reason                                                                                                 | Suggested change |
| ----- | --------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ | ---------------- |
| 19–56 | Semantic `section`, `h1`, and `p` | keep with reason | These are document semantics, not interactive controls; no DS component covers a branded hero heading. | —                |
| 25–29 | App identity                      | keep with reason | Reuses the canonical `AppLogo` component and packaged application asset.                               | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                        | Verdict          | Reason                                                                        | Suggested change |
| ---- | ---------------------------- | ---------------- | ----------------------------------------------------------------------------- | ---------------- |
| —    | No arbitrary Tailwind values | keep with reason | All composition classes are centralized in `SETUP_WALKTHROUGH_LAYOUT_TOKENS`. | —                |

## D3 — Hardcoded Sizes / Colors

| Line | Value               | Verdict          | Reason                                                                                     | Suggested change |
| ---- | ------------------- | ---------------- | ------------------------------------------------------------------------------------------ | ---------------- |
| 27   | `AppLogo size={36}` | keep with reason | The logo component owns the asset contract; 36px is the deliberate desktop hero mark size. | —                |

## D4 — Accessibility

| Line         | Element              | Verdict          | Reason                                                                                                                                             | Suggested change |
| ------------ | -------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| 19–21, 36–44 | Labelled hero region | keep with reason | The section is labelled by one visible `h1`; supporting copy follows in a paragraph.                                                               | —                |
| 47–53        | Mascot scene         | keep with reason | Decorative planet and mascot are grouped under `aria-hidden`; the brand logo also has an empty alt to avoid duplicate announcement beside “ORGII”. | —                |

## D5 — Visual Patterns Observed

- This is the sole cinematic setup hero. It remains feature-local until another product surface needs the same composition.

## Summary

- 0 fixes recommended
- 5 kept with documented reason
- 0 abstract candidates
