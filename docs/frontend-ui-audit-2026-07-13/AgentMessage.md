# Frontend UI Audit — AgentMessage

**File:** `src/engines/ChatPanel/events/stream/agent-message/index.tsx` (429 LOC)
**Date:** 2026-07-13
**Auditor:** Codex
**Scope:** Whole-file D1–D5 audit of the current source; the hook-only diff is noted separately below.

## D1 — Raw HTML vs Design System

No raw interactive or covered structural elements (`button`, `input`, `select`, `textarea`, `dialog`, `details`, `summary`, `table`, or `form`) appear in this file. Interactive behavior is delegated to the existing event-block and message components.

## D2 — Arbitrary Tailwind Value vs Token

No arbitrary CSS-variable or literal-color Tailwind values appear in this file.

## D3 — Hardcoded Sizes / Colors

No pixel-literal Tailwind sizes or raw color literals appear in this file.

## D4 — Accessibility

| Line  | Element                                                | Verdict       | Reason                                                                                                                                                                                                                                                                    | Suggested change                                                                                                                                                                                  |
| ----- | ------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 84–90 | Collapsible thinking toggle via `EventBlockHeaderIcon` | fix candidate | This call supplies `onToggle`, which `EventBlockHeaderIcon.tsx:95–104` renders as a clickable `<span>` without a semantic role, keyboard handling, or an accessible name. Delegating the interaction to a shared primitive does not make the rendered control accessible. | Fix `EventBlockHeaderIcon` once at the shared-primitive level (prefer a named `IconButton`/`button`, or provide equivalent role, focus, keyboard, and naming semantics), then verify its callers. |

This is shared primitive debt rather than a reason to patch `AgentMessage` locally. The full caller sweep belongs in the follow-up accessibility change.

## D5 — Visual Patterns Observed

- The historical `<think>` presentation at lines 66–105 reuses the shared event-block primitives and the established `activity-thinking` classes. The same visual vocabulary appears in `ThinkingEvent` and `ThinkBubble`; those sites already share lower-level primitives/styles, so this file does not justify another presentation component by itself.
- The collapsible-chevron interaction is also shared through `EventBlockHeaderIcon`; its repeated use makes the D4 issue a shared-primitive fix, not a local abstraction candidate.
- Canvas presentation at lines 233–244 is delegated to the shared `CanvasInlineCard`, which is also consumed by `CanvasInlineAdapter` and Markdown rendering. The card UI is already abstracted.
- The current source diff only replaces `useCanvasPreviewForSession` with `useCanvasForTurn`; it does not add or restyle visible UI.

## Summary

- 1 fix recommended (shared `EventBlockHeaderIcon` accessibility follow-up)
- 0 kept with documented reason
- 0 abstract candidates
- Total source changes in this audit: 0. Landing belongs to a separate accessibility fix in `EventBlockHeaderIcon`, followed by verification of its callers; no D1–D3 UI sweep is required for this file.
