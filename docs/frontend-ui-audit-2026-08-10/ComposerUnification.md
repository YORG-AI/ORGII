# Frontend UI Audit — Composer Unification

**Files:** `src/components/ComposerBar/index.tsx`, `src/components/Voice/VoiceRecordingBar.tsx`, `src/engines/ChatPanel/InputArea/**`, `src/engines/ChatPanel/index.tsx`, `src/features/SessionCreator/**`, `src/modules/ProjectManager/shared/components/CreateComposerScaffold.tsx`
**Date:** 2026-08-10
**Auditor:** Codex review of PR #766

## D1 — Raw HTML vs Design System

| Line                                      | Element                             | Verdict          | Reason                                                                                                                                                                                                                                                           | Suggested change                                                    |
| ----------------------------------------- | ----------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `ComposerBar/index.tsx:78`                | Skills & Tools `<button>`           | keep with reason | This is a focus-preserving menu anchor with a pill-specific surface, test selectors, and custom mouse-down behavior; the shared `IconButton` radius/variant contract does not cover the complete trigger behavior without restyling it back into this component. | —                                                                   |
| `VoiceRecordingBar.tsx:80,112,123`        | Recording controls                  | keep with reason | The controls form one custom waveform row; the disabled add placeholder, accept emphasis, and exact circular geometry are not a direct `IconButton` variant match. Shared input-area button tokens still provide sizing.                                         | —                                                                   |
| `SessionCreatorChatPanelView.tsx:357,412` | TUI launch and Share Screen buttons | keep with reason | Both are established, bespoke full-width/dashed controls in this surface. Replacing only these sites would recreate their current styling through overrides and would not improve consistency in this composer-only PR.                                          | Consider a dedicated button-variant sweep if these patterns spread. |
| `CreateComposerScaffold.tsx:135`          | Hidden file `<input>`               | keep with reason | The native file input is an invisible, programmatically triggered picker; visible input design-system components do not cover this role.                                                                                                                         | —                                                                   |

## D2 — Arbitrary Tailwind Value vs Token

| Line                      | Value                              | Verdict          | Reason                                                                                                                                     | Suggested change                                                        |
| ------------------------- | ---------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `InputAreaChrome.tsx:150` | drag-over `color-mix(...)` classes | keep with reason | This composes project-owned primary/chat-input tokens for a transient drag state; there is no equivalent named Tailwind token.             | Watch with the creator peer below.                                      |
| `EditorArea.tsx:522`      | drag-over `color-mix(...)` classes | keep with reason | Same intentional transient state as the session composer. The repository sweep found two implementations, below the abstraction threshold. | Promote both to a shared state token if a third implementation appears. |

## D3 — Hardcoded Sizes / Colors

| Line                                      | Value                             | Verdict          | Reason                                                                                                                                                                                                                                                                     | Suggested change                           |
| ----------------------------------------- | --------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `inputAreaTokens.ts:83-94`                | `60/140`, `text-[14px]`, `gap-px` | keep with reason | These values are now centralized as the shared editor and control-group contract used by both session and creator surfaces. A repository sweep found 117 existing `text-[14px]` uses, so changing typography syntax belongs to a dedicated sweep, not a site-by-site edit. | —                                          |
| `VoiceRecordingBar.tsx:106`               | `min-w-[2.5rem]`, `text-[12px]`   | keep with reason | The timer needs a fixed tabular width to avoid waveform movement; 12px matches the existing compact control typography.                                                                                                                                                    | —                                          |
| `ControlButtons/index.tsx:97`             | `max-w-[360px]`                   | keep with reason | This is a content cap for the model label/dropdown trigger, not a spacing-scale size. The sweep found one semantic peer in `ModelPill`.                                                                                                                                    | Watch-list only (2 sites).                 |
| `SessionCreatorChatPanelView.tsx:361,414` | `text-[13px]`, `text-[12px]`      | keep with reason | Existing bespoke CTA and utility-pill typography was not introduced by the composer layout refactor.                                                                                                                                                                       | Revisit only in a typography-system sweep. |
| `CreateComposerScaffold.tsx:34`           | `text-[14px]`                     | keep with reason | Existing create-title typography aligns with the shared 14px composer scale; this PR does not expand the pattern.                                                                                                                                                          | —                                          |

## D4 — Accessibility

| Line                                      | Element                          | Verdict          | Reason                                                                         | Suggested change                                            |
| ----------------------------------------- | -------------------------------- | ---------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `VoiceRecordingBar.tsx:80`                | Icon-only add control            | fix (resolved)   | The enabled icon-only button previously had no accessible name.                | Added `aria-label={t("common:actions.add")}` during review. |
| `ComposerBar/index.tsx:78`                | Icon-only Skills & Tools trigger | keep with reason | It has an explicit accessible name and native button keyboard semantics.       | —                                                           |
| `VoiceRecordingBar.tsx:112,123`           | Cancel and accept controls       | keep with reason | Both have translated accessible names and native button keyboard semantics.    | —                                                           |
| `SessionCreatorChatPanelView.tsx:357,412` | Text buttons                     | keep with reason | Visible text supplies their accessible names and native button semantics.      | —                                                           |
| `ChatPanel/index.tsx:686`                 | Launchpad rail placeholder       | keep with reason | The spacer is non-interactive and explicitly hidden from assistive technology. | —                                                           |

## D5 — Visual Patterns Observed

- Shared editor bounds, editor presentation, and control spacing are already abstracted in `inputAreaTokens.ts` and consumed by both session and creator surfaces.
- Drag-over color-mix state: two implementations (`InputAreaChrome.tsx`, `EditorArea.tsx`) — watch-list, below the three-site abstraction threshold.
- 360px model-trigger cap: two implementations (`ControlButtons`, `ModelPill`) — watch-list, below the abstraction threshold.
- No new repeated visual/behavior pattern reaches the abstraction threshold.

## Summary

- 1 fix recommended and resolved during review
- 12 findings kept with documented reason
- 0 abstract candidates (>= 3 independent implementations)
