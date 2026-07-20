# Frontend UI Audit — DiffStats Reuse Sweep

**Files:** `src/components/DiffStatsBadge/index.tsx` (111 LOC), `src/engines/ChatPanel/InputArea/hooks/useComposerSections.ts` (437 LOC), `src/engines/ChatPanel/ChatItems/EditActivityGroup/index.tsx` (254 LOC), and `origin/develop:src/modules/WorkStation/shared/StatusBar/EditorStatusBar.tsx` (648 LOC)
**Date:** 2026-07-17
**Auditor:** Codex
**Compared refs:** working tree on `feat/i18n-locale-completeness`; local tracking ref `origin/develop` at `5be17525b`

## D1 — Raw HTML vs Design System

| Line                                         | Element                                     | Verdict          | Reason                                                                                                                                                                             | Suggested change |
| -------------------------------------------- | ------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `useComposerSections.ts:84-102`              | `React.createElement("span")` diff values   | keep with reason | These are non-interactive inline text nodes; no design-system interactive primitive applies. The reuse issue is the repeated diff-stat composition, covered in D5.                 | —                |
| `EditActivityGroup/index.tsx:219-235`        | `<span>` diff summary                       | keep with reason | Non-interactive inline summary text; raw spans are appropriate. The duplicated `+N/-N` rendering should be replaced at the component level, not by a generic structural primitive. | —                |
| `origin/develop:EditorStatusBar.tsx:297-309` | `<DiffStatsBadge>` inside `StatusBarButton` | keep with reason | The status bar already uses both shared primitives: `StatusBarButton` for interaction and `DiffStatsBadge` for the inline working-tree totals shown in the screenshot.             | —                |

## D2 — Arbitrary Tailwind Value vs Token

| Line | Value                                                                            | Verdict          | Reason                                                                                                                                          | Suggested change |
| ---- | -------------------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| —    | No CSS-variable or raw-color arbitrary values in the audited diff-stat renderers | keep with reason | The two manual sites use named Tailwind colors or `DIFF_STATS`; the issue is semantic token/component reuse rather than arbitrary-value syntax. | —                |

## D3 — Hardcoded Sizes / Colors

| Line                                         | Value                                                         | Verdict          | Reason                                                                                                                                                        | Suggested change                                                                                                                                           |
| -------------------------------------------- | ------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `useComposerSections.ts:88`                  | `text-green-500`                                              | fix candidate    | Diff additions already have the project semantic token `DIFF_STATS.additions` (`text-success-6`) and are normally rendered by `DiffStatsBadge`.               | Replace the hand-built nodes with `DiffStatsBadge variant="plain"`; preserve the current inherited size, normal weight, and spacing through props/classes. |
| `useComposerSections.ts:97`                  | `text-red-500`                                                | fix candidate    | Diff deletions already have the project semantic token `DIFF_STATS.deletions` (`text-danger-6`) and are normally rendered by `DiffStatsBadge`.                | Same component-level replacement as above.                                                                                                                 |
| `EditActivityGroup/index.tsx:225-233`        | `DIFF_STATS.additions` / `DIFF_STATS.deletions` used directly | keep with reason | The colors are semantic tokens, so there is no color-token violation. This still bypasses the shared rendering component and is therefore a D5 fix candidate. | —                                                                                                                                                          |
| `origin/develop:EditorStatusBar.tsx:297-309` | `DiffStatsBadge size="xs"`                                    | keep with reason | Uses the badge's named typography size and plain variant; it does not repeat a pixel literal or raw color.                                                    | —                                                                                                                                                          |

## D4 — Accessibility

| Line                                         | Element                           | Verdict          | Reason                                                                                                                                         | Suggested change |
| -------------------------------------------- | --------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `useComposerSections.ts:84-102`              | Inline `+N/-N` text               | keep with reason | The values are visible text inside the existing composer control; no icon-only accessible-name gap or non-semantic click target is introduced. | —                |
| `EditActivityGroup/index.tsx:219-235`        | Inline `+N/-N` text               | keep with reason | Static visible summary text; no keyboard interaction is attached to the spans.                                                                 | —                |
| `origin/develop:EditorStatusBar.tsx:297-309` | Badge inside branch switch button | keep with reason | The containing `StatusBarButton` receives an accessible branch-switch label; the diff values are supplementary visible text.                   | —                |

## D5 — Visual Patterns Observed

| Pattern                           | Where                                                                                                              |                     Count | Verdict          | Suggested change                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------: | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Shared `DiffStatsBadge` rendering | `origin/develop`, across file headers, diff viewers, source control, chat, inbox, status bar, and related surfaces | 24 call sites in 22 files | keep with reason | This is the established abstraction. The screenshot's status-bar values are one of these call sites.               |
| Hand-built `+N/-N` diff stats     | `useComposerSections.ts:84-102`; `EditActivityGroup/index.tsx:219-235`                                             |              2 call sites | fix candidate    | Migrate both to `DiffStatsBadge variant="plain"` with `reserveValueWidth={false}` and context-specific gap/weight. |
| Non-UI diff formatting            | `src/shared/pr/formatStatNumber.ts`; diff-content serialization in `DiffBlock`                                     |              2 categories | keep with reason | These produce strings for tooltips/content rather than reusable visual UI, so `DiffStatsBadge` is not applicable.  |

The sweep found 26 UI render sites on the local `origin/develop`: 24 already reuse `DiffStatsBadge`, while 2 remain hand-built. That is broad reuse (about 92%), not widespread duplication. The two misses are still worth fixing together because they encode color, spacing, zero suppression, and sign rendering outside the shared component.

## Next-refactor candidates

- Migrate `createFileInlineSection` to `React.createElement(DiffStatsBadge, ...)`. The file is `.ts`, but that does not block component reuse.
- Migrate `EditActivityGroup`'s summary spans to `DiffStatsBadge variant="plain"`.
- Keep `EditorStatusBar` unchanged: the screenshot already demonstrates the intended shared-component usage.

## Summary

- 2 fixes recommended
- 11 kept with documented reason
- 0 new abstract candidates; the correct abstraction (`DiffStatsBadge`) already exists
