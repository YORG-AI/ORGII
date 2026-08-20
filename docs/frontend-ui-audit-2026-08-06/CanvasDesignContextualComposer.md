# Frontend UI Audit — CanvasDesignContextualComposer

**Files:** `src/engines/Simulator/apps/canvas/design/CanvasDesignSurface.tsx`, `src/engines/ChatPanel/InputArea/index.tsx`, `src/engines/ChatPanel/InputArea/inputAreaPresentation.ts`, `src/engines/ChatPanel/InputArea/components/InputComposerBars.tsx`, `src/engines/ChatPanel/InputArea/components/InputEditor.tsx`, `src/components/ComposerInput/index.scss`
**Date:** 2026-08-06
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line                          | Element                | Verdict          | Reason                                                                                                                                                                   | Suggested change |
| ----------------------------- | ---------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `InputArea/index.tsx:657`     | hidden file `<input>`  | keep with reason | Native file-input behavior and its imperative ref are required by the shared upload flow; the control is hidden and activated through the design-system composer action. | —                |
| `CanvasDesignSurface.tsx:93`  | selected-element pill  | keep with reason | Uses the shared `BasePill` editor variant and existing pill size token rather than introducing a Canvas-specific chip.                                                   | —                |
| `CanvasDesignSurface.tsx:397` | selection close action | keep with reason | Uses the shared `IconButton` rather than introducing a raw interactive element.                                                                                          | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                         | Verdict          | Reason                                                                                 | Suggested change |
| ---- | ----------------------------- | ---------------- | -------------------------------------------------------------------------------------- | ---------------- |
| —    | No new arbitrary color values | keep with reason | The contextual composer uses existing surface, text, border, fill, and primary tokens. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                            | Value                     | Verdict          | Reason                                                                                                                                | Suggested change |
| ------------------------------- | ------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CanvasDesignSurface.tsx:419`   | 15px close icon           | keep with reason | Sub-16px optical size matches compact toolbar icon proportions and does not represent layout spacing.                                 | —                |
| `CanvasDesignSurface.tsx:62-68` | prompt geometry constants | keep with reason | These values are viewport collision and Replay-control clearance bounds calculated in CSS pixels, not reusable visual spacing tokens. | —                |

## D4 — Accessibility

| Line                          | Element                    | Verdict          | Reason                                                                                                     | Suggested change |
| ----------------------------- | -------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- | ---------------- |
| `CanvasDesignSurface.tsx:273` | contextual composer dialog | keep with reason | The portal has `role="dialog"` and a translated accessible name.                                           | —                |
| `CanvasDesignSurface.tsx:93`  | selected-element pill      | keep with reason | The dismiss action has a translated accessible name, native focus participation, and Enter/Space handling. | —                |
| `CanvasDesignSurface.tsx:397` | close `IconButton`         | keep with reason | The icon-only control has a translated `aria-label`; the nested icon is hidden from assistive technology.  | —                |

## D5 — Visual Patterns Observed

| Line                              | Element                               | Verdict          | Reason                                                                                                                                                                 | Suggested change                                                                                                                                                                   |
| --------------------------------- | ------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `InputComposerBars.tsx:383-415`   | contextual selected-element reference | fix              | The reference previously sat beside the full-width `InputEditor` inside `ComposerBar`, so the two independent layout boxes produced a tall, offset first row.          | Route the existing `BasePill` through `InputEditor.leadingContent`, keeping it on the editor's first line without adding it to the serialized document. Implemented.               |
| `InputArea/index.tsx:360-379`     | contextual composer geometry          | fix              | The Design prompt previously forced the stacked shared-composer presentation even for a single-line draft, leaving unnecessary vertical space.                         | Route eligible contextual prompts through the existing compact `ComposerShell`/`ComposerBar` state and retain the existing multiline expansion gate. Implemented.                  |
| `CanvasDesignSurface.tsx:266-305` | contextual composer visual shell      | fix              | A Canvas-only rounded background wrapper painted behind the shared compact shell, creating a second surface with a mismatched radius at the right edge.                | Remove the duplicate painted wrapper, keep the portal as a non-painting drop-shadow container, and let the shared `ComposerShell` own background, border, and radius. Implemented. |
| `CanvasDesignSurface.tsx:93-123`  | selected-element pill shell           | keep with reason | It reuses `BasePill`, `PILL_SIZE`, and the editor-pill pointer-to-close interaction, so icon, type, color, and baseline stay aligned with editable `@pill` references. | —                                                                                                                                                                                  |

- The feature extends the shared `InputArea`, `ComposerBar`, `ComposerShell`, `BasePill`, and `IconButton` paths. No parallel Canvas-only input or button pattern was introduced.
- The contextual layout is an explicit shared `InputArea` presentation and is covered alongside the existing compact presentation.
- `InputEditor.leadingContent` is deliberately a visual adornment rather than a `ComposerInput` document node: Canvas selection metadata already has a dedicated submit payload, so serializing the same reference would duplicate context and make an otherwise empty input appear sendable.

## Summary

- 3 fixes implemented
- 10 kept with documented reason
- 0 abstract candidates
