# Frontend UI Audit — CanvasRevisionActivityAndProgress

**Files:** `src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasRevisionActivity.tsx`, `src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasRevisionProgress.tsx`, `src/engines/ChatPanel/blocks/CanvasInlineCard/CanvasRevisionSteps.tsx`, `src/engines/ChatPanel/events/stream/agent-message/index.tsx`, `src/engines/Simulator/apps/canvas/CanvasApp.tsx`, `src/config/toolIcons.tsx`
**Date:** 2026-08-06
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                            | Element                   | Verdict          | Reason                                                                                                                                          | Suggested change |
| ------------------------------- | ------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CanvasRevisionProgress.tsx:33` | progress status container | keep with reason | This is non-interactive status content, so a semantic `div` with `role="status"` is appropriate and does not duplicate a design-system control. | —                |
| `CanvasApp.tsx:783`             | Canvas overlay wrapper    | keep with reason | The wrapper only positions a shared progress component and deliberately disables pointer events; it is not an interactive control.              | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line                            | Value                                 | Verdict          | Reason                                                                                                                                 | Suggested change |
| ------------------------------- | ------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CanvasRevisionProgress.tsx:41` | `max-w-[min(28rem,calc(100vw-2rem))]` | keep with reason | The expression combines the desired compact maximum with a viewport collision bound; no single design token captures both constraints. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                               | Value                         | Verdict          | Reason                                                                                                                                     | Suggested change                                                                                             |
| ---------------------------------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `CanvasRevisionProgress.tsx:46-48` | 13px pen / 27px activity ring | keep with reason | These are optical icon sizes inside the token-sized `h-7 w-7` status mark, not reusable layout spacing.                                    | —                                                                                                            |
| `CanvasRevisionProgress.tsx:57`    | 11px secondary status text    | keep with reason | The compact secondary line follows the existing event-metadata hierarchy and remains supplementary to the 12px title.                      | —                                                                                                            |
| `CanvasRevisionSteps.tsx:19-35`    | step icon size                | keep with reason | The icons use the shared `SESSION_UI_TOKENS.ICON.SIZE_XS` value rather than introducing a Canvas-local size.                               | —                                                                                                            |
| `CanvasRevisionActivity.tsx:120`   | `ml-[14px]` timeline inset    | abstract         | The same 14px icon-column inset appears in Thinking, ContextCompacted, and StackedBlock; it is an established pattern with four consumers. | Promote the full timeline inset/border class to a shared event-block primitive in a dedicated cleanup sweep. |

## D4 — Accessibility

| Line                               | Element                   | Verdict          | Reason                                                                                                             | Suggested change |
| ---------------------------------- | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `CanvasRevisionProgress.tsx:36-37` | streamed revision status  | keep with reason | `role="status"` with polite live announcements exposes phase changes without interrupting the user.                | —                |
| `CanvasRevisionProgress.tsx:46-50` | decorative progress icons | keep with reason | Both icons are hidden from assistive technology, and reduced-motion users receive a static indicator.              | —                |
| `CanvasRevisionSteps.tsx:62-76`    | ordered work-step list    | keep with reason | A translated list label names the process; icon state is reinforced by text and DOM state rather than color alone. | —                |

## D5 — Visual Patterns Observed

- Chat and Canvas reuse one `CanvasRevisionProgress` component; only the placement variant changes.
- Running and historical surfaces reuse one `CanvasRevisionSteps` component and one pure phase-state mapping.
- The persistent record reuses `EventBlockHeader`, its icon/title/subtitle slots, and `getEventBlockContainerClasses` instead of creating a Canvas-specific card shell.
- Canvas resolves its icon through the shared Rust-to-Lucide registry; the missing `layout` mapping was fixed in `toolIcons.tsx` rather than hardcoding an icon in the activity component.
- The component uses existing background, border, text, and primary tokens. No Canvas-only button, input, or color system was introduced.
- The Canvas overlay is pointer-transparent, so it cannot steal hover, selection, or Design-mode input from the preview beneath it.

## Summary

- 0 fixes recommended
- 9 kept with documented reason
- 1 abstract candidate
