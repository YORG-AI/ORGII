# Frontend UI Audit — i18n Accessibility Sweep

**Files:** `src/features/CodeViewer/ModernSplitDiff.tsx`, `src/features/SessionCreator/components/UploadPills/index.tsx`, `src/features/SessionCreator/components/ImageThumbnailRow.tsx`, `src/engines/ChatPanel/InputArea/components/ImageAttachmentPreview.tsx`, `src/engines/ChatPanel/InputArea/components/EditModeImageThumbnail.tsx`
**Date:** 2026-07-16
**Auditor:** ORGII agent session

## D1 — Raw HTML vs Design System

| Line / area                   | Element                  | Verdict          | Reason                                                                                                                                                                                     | Suggested change                                      |
| ----------------------------- | ------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| `ModernSplitDiff.tsx` header  | cherry-pick-all control  | fix              | The control was a clickable `div`; native button semantics cover its behavior.                                                                                                             | Replaced with `<button type="button">`.               |
| Attachment thumbnail overlays | icon-only remove buttons | keep with reason | These are absolutely positioned, hover-revealed controls with custom 16–20 px hit areas; the current design-system `IconButton` does not cover this overlay layout without visual changes. | Keep raw buttons; provide localized accessible names. |

## D2 — Arbitrary Tailwind Value vs Token

| Line / area                   | Value                  | Verdict          | Reason                                                                             | Suggested change |
| ----------------------------- | ---------------------- | ---------------- | ---------------------------------------------------------------------------------- | ---------------- |
| Attachment thumbnail controls | Existing token classes | keep with reason | No new arbitrary color or CSS-variable values were introduced by this i18n change. | —                |

## D3 — Hardcoded Sizes / Colors

| Line / area                   | Value                               | Verdict          | Reason                                                                                                     | Suggested change |
| ----------------------------- | ----------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| Attachment thumbnail controls | Existing 4–20 px icon/overlay sizes | keep with reason | Existing compact overlay geometry was not part of the localization change; changing it would alter the UI. | —                |

## D4 — Accessibility

| Line / area                     | Element           | Verdict | Reason                                                             | Suggested change                                                      |
| ------------------------------- | ----------------- | ------- | ------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `ModernSplitDiff.tsx` header    | clickable `div`   | fix     | Lacked native keyboard semantics and an explicit accessible name.  | Converted to a button and added localized `aria-label`.               |
| Four attachment remove controls | icon-only buttons | fix     | Existing English-only labels prevented localized accessible names. | Reused `common.actions.remove` and retained the file name as context. |

## D5 — Visual Patterns Observed

- Pattern: absolutely positioned thumbnail remove button — present in four attachment components. The visual implementations differ in size and surrounding thumbnail behavior, so this pass keeps them local rather than introducing a shared component during an i18n sweep.

## Summary

- 5 fixes applied
- 2 categories kept with documented reason
- 0 new abstraction candidates landed
