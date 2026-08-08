# Frontend UI Audit — CanvasInlineCard

**Files:** `src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasPreviewSurface.tsx`, `src/engines/ChatPanel/blocks/CanvasInlineCard/ReactArtifactRunner.tsx`
**Date:** 2026-08-04
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                         | Element                          | Verdict          | Reason                                                                                                         | Suggested change |
| ---------------------------- | -------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CanvasPreviewSurface:62-70` | External URL action              | keep with reason | The action uses the shared `Button` component with a visible localized label and icon.                         | —                |
| `ReactArtifactRunner:75-91`  | React Live host `<div>` elements | keep with reason | These are non-interactive runtime host and scrolling elements; no design-system interactive primitive applies. | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line             | Value                                   | Verdict          | Reason                                                                                      | Suggested change |
| ---------------- | --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------- | ---------------- |
| Changed surfaces | No arbitrary project color tokens added | keep with reason | Static HTML theme values use the existing CSS design tokens inside the Shadow DOM boundary. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                       | Value         | Verdict          | Reason                                                                                                                                                        | Suggested change |
| -------------------------- | ------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CanvasPreviewSurface:191` | `text-[10px]` | keep with reason | This is compact diagnostic stack text inside an existing error overlay, below the spacing-scale threshold and intentionally subordinate to the error message. | —                |

## D4 — Accessibility

| Line                         | Element                   | Verdict          | Reason                                                                                                                                                           | Suggested change |
| ---------------------------- | ------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CanvasPreviewSurface:62-70` | Open-in-browser action    | keep with reason | Shared `Button` provides keyboard semantics and the localized visible text supplies the accessible name.                                                         | —                |
| Static HTML host             | Sanitized display content | keep with reason | The host is a read-only content surface; scripts, iframes, event handlers, and boundary-escaping styles are rejected rather than exposed as ungoverned controls. | —                |

## D5 — Visual Patterns Observed

- The four canvas modes continue to share `CanvasPreviewSurface`; no parallel card or error-overlay implementation is introduced.
- Static HTML receives the same application theme tokens through its contained Shadow DOM rather than adding a second visual recipe.

## Summary

- 0 fixes recommended
- 6 kept with documented reason
- 0 abstract candidates
