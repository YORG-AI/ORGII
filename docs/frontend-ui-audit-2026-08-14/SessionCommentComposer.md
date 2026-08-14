# Frontend UI Audit — Markdown Editor Consolidation

**Files:** `src/modules/shared/components/MarkdownTextareaEditor/*`, `src/components/MarkdownFormattingToolbar/index.scss`, and the migrated comment, issue, pull-request, history, work-item, and project-description callers
**Date:** 2026-08-14
**Auditor:** Codex focused review (the configured `frontend-ui-audit` skill file was unavailable)

## D1 — Raw HTML vs Design System

| Line / area       | Element                                   | Verdict          | Reason                                                                                                                                                                       | Suggested change                                                                                                                     |
| ----------------- | ----------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Comment composer  | Plain `Textarea` and detached action row  | fix (resolved)   | Session comments supported Markdown syntax but used a separate input and action layout from the established pull-request composer.                                           | Added the shared native `MarkdownTextareaEditor` inside `ComposerSurface`; Mention, Cancel, and Send share the contained action bar. |
| Comment edit mode | Plain `Textarea` and detached action row  | fix (resolved)   | Editing the same Markdown body through a plain textarea produced a second visual and interaction pattern.                                                                    | Reused the lightweight Markdown toolbar, composer shell, and contained Cancel/Save actions.                                          |
| Product editors   | Tiptap engine plus shared wrapper         | fix (resolved)   | Issue, PR, history, work-item, and project-description surfaces carried a second editor engine for the same stored Markdown contract.                                        | Migrated every production caller to `MarkdownTextareaEditor` and removed both legacy layers.                                         |
| Editor toolbar    | Separate rich/light implementations       | fix (resolved)   | Parallel toolbar implementations could drift while exposing the same Markdown actions.                                                                                       | Kept one extracted formatting-toolbar stylesheet and one action implementation.                                                      |
| Editor mode       | Full-width Write / Preview header         | fix (resolved)   | The dedicated header consumed vertical space and diverged from the compact Agent / Manual mode control.                                                                      | Reused `SegmentedTextPill` and moved Write / Preview into each composer or form's bottom action row.                                 |
| Footer alignment  | Interactive controls split left and right | fix (resolved)   | Mention, review, add-content, and submit controls moved between sides across otherwise equivalent composer rows.                                                             | Kept Write / Preview on the left and grouped every other interactive footer control on the right.                                    |
| Agent suggestion  | Native `<button>`                         | keep with reason | This is a focus-preserving, full-width suggestion row with bespoke mixed-content labeling; the shared `Button` variants do not represent this inline recommendation pattern. | Keep until the suggestion-row pattern appears in at least three independent surfaces.                                                |

## D2 — Arbitrary Tailwind Value vs Token

| Line / area    | Value                               | Verdict          | Reason                                                                                                                                                        | Suggested change                                                                                            |
| -------------- | ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Member picker  | Unstyled dropdown panel             | fix (resolved)   | The caller omitted the reusable dropdown surface and width tokens, leaving only positioned search/list content with no opaque box, border, radius, or shadow. | Applied `DROPDOWN_CLASSES.panel` and `DROPDOWN_WIDTHS.fileTreeClass`.                                       |
| Member trigger | No persistent open-state treatment  | fix (resolved)   | The dropdown exposed its visibility state, but the trigger did not reflect that state visually.                                                               | Connected `onVisibleChange` to the shared active pill token and native ARIA disclosure semantics.           |
| Comment editor | `minHeight={72}`, `maxHeight={240}` | keep with reason | These are editor behavior bounds, not duplicated surface styling; the compact comment context needs a smaller range than the 100–500px pull-request dock.     | Promote to a named editor-size preset if another compact Markdown composer needs the same bounds.           |
| Shared editor  | Numeric or CSS-string height props  | keep with reason | The consolidated editor serves compact comments, docked PR forms, and full description panels whose layout constraints are owned by their parent surface.     | Keep layout ownership at the caller; introduce presets only when repeated values form stable product tiers. |

## D3 — Hardcoded Sizes / Colors

| Line / area                        | Value                                      | Verdict          | Reason                                                                                                                                                                 | Suggested change                                             |
| ---------------------------------- | ------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Mention chips and compact metadata | Existing 10–12px typography and width caps | keep with reason | These values predate this refactor and encode compact thread metadata and overflow behavior; changing them is outside the requested composer/dropdown consistency fix. | Review only as part of a dedicated compact-typography sweep. |

## D4 — Accessibility

| Line / area       | Element                                                | Verdict          | Reason                                                                                                                                                                                                                                              | Suggested change |
| ----------------- | ------------------------------------------------------ | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Composer actions  | Mention, Cancel, Send / Save                           | keep with reason | Shared `Button` components retain native button semantics, visible labels, disabled states, and the established pull-request sizing.                                                                                                                | —                |
| Markdown composer | Native textarea with segmented Write / Preview control | keep with reason | The textarea preserves native selection/undo/IME behavior; the shared segmented control exposes pressed state, every formatting control has a translated accessible label, Preview uses the shared renderer, and Cmd/Ctrl+Enter retains submission. | —                |

## D5 — Visual Patterns Observed

- Pull-request and session-comment composers use the same shared editor, Markdown toolbar chrome, and contained action-row placement.
- All migrated product surfaces now use the same GitHub-style Write / Preview editor and shared Markdown renderer.
- Write / Preview uses the same compact segmented control as Agent / Manual and lives on the left of the bottom row; actionable footer controls stay grouped on the right.
- Saved session comments now use the shared `MarkdownContent` renderer already used by pull-request conversation content.
- The member picker now uses the centralized dropdown panel, list, search, and width token system.
- The old rich-editor wrapper, Tiptap runtime, node extensions, and duplicated toolbar implementation were removed.
- No new visual pattern reaches the abstraction threshold.

## React Performance Review

- **Applicable:** comment panels can mount multiple editors, and issue/PR/project surfaces previously paid for a separate editor runtime despite persisting Markdown strings.
- **Implementation:** `MarkdownTextareaEditor` owns one native textarea, pure selection transforms, an on-demand shared Markdown preview, and one layout effect that restores selection when returning to Write. It registers no global listeners, observers, timers, or subscriptions. Markdown parsing only runs while Preview is selected; session comments retain their existing 4,000-character limit, while longer issue and description content remains caller-owned.
- **Equivalent callers:** all production `RichMarkdownEditor` callers now use the same component. Advanced project-description contracts remain available through the shared ref: file/context insertion, image insertion, mention/slash triggers, focus, clear, and content access.
- **Evidence:** focused component coverage asserts one textarea, on-demand Preview, read-only Preview, native formatting, stable file-reference serialization, and the absence of `contenteditable`. The package and source sweeps find no Tiptap runtime import or dependency. Runtime WebView RAM/FPS and bundle-size changes were not measured, so no numeric performance improvement is claimed.

## Summary

- 8 fixes recommended and resolved
- 6 findings kept with documented reason
- 0 abstract candidates (>= 3 independent implementations)
