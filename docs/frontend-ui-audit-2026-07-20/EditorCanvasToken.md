# Frontend UI Audit — Editor Canvas Token

**Scope:** six changed `*.tsx` consumers of the CodeMirror editor-canvas background
**Date:** 2026-07-20
**Auditor:** Codex

## D1 — Raw HTML vs Design System

| Line | Element                         | Verdict          | Reason                                                                                                          | Suggested change |
| ---: | ------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- | ---------------- |
|    — | Existing containers and buttons | keep with reason | This sweep changes only background-token ownership; replacing established semantic elements would be unrelated. | None.            |

## D2 — Arbitrary Tailwind Value vs Token

|                                 Line | Element                           | Verdict  | Reason                                                                                                                   | Suggested change                  |
| -----------------------------------: | --------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
|          `ActivitySimulator.tsx:255` | Empty simulator canvas            | abstract | Repeated `bg-[var(--cm-editor-background)]` encoded the same workstation surface contract locally.                       | Use `EDITOR_TAB_CANVAS_BG_CLASS`. |
|       `SubagentPromptToggle.tsx:131` | Prompt dialog canvas              | abstract | Same editor-canvas background contract as the simulator and diff surfaces.                                               | Use `EDITOR_TAB_CANVAS_BG_CLASS`. |
|            `CombinedDiffView.tsx:72` | Sticky diff header                | abstract | Same editor-canvas background contract as other workstation headers.                                                     | Use `EDITOR_TAB_CANVAS_BG_CLASS`. |
|      `DiffFileSection/index.tsx:416` | Diff file header                  | abstract | Same editor-canvas background contract as other diff headers.                                                            | Use `EDITOR_TAB_CANVAS_BG_CLASS`. |
| `FocusedChatWorkstationRail.tsx:331` | Focused-chat workstation rail     | abstract | A new exact editor-canvas background literal landed on `develop` after the original audit and belongs to the same sweep. | Use `EDITOR_TAB_CANVAS_BG_CLASS`. |
|          `PanelHeader/index.tsx:294` | `editorCanvas` background variant | abstract | The named variant should resolve through the shared workstation token rather than restating its implementation.          | Use `EDITOR_TAB_CANVAS_BG_CLASS`. |

## D3 — Hardcoded Sizes / Colors

| Line | Element                | Verdict          | Reason                                                                                                      | Suggested change |
| ---: | ---------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------- | ---------------- |
|    — | Changed surface colors | keep with reason | No literal color or new size was introduced; the sweep removes five repeated arbitrary-value class strings. | None.            |

## D4 — Accessibility

| Line | Element           | Verdict          | Reason                                                                                                | Suggested change |
| ---: | ----------------- | ---------------- | ----------------------------------------------------------------------------------------------------- | ---------------- |
|    — | Existing controls | keep with reason | Class composition only; roles, accessible names, focus behavior, and keyboard behavior are unchanged. | None.            |

## D5 — Visual Patterns Observed

- `EDITOR_TAB_CANVAS_BG_CLASS` is now the single shared expression for the six exact editor-canvas background uses in changed TSX surfaces.
- No additional multi-file design-system sweep candidate was found in this scope.

## Summary

- 0 fixes recommended
- 3 kept with documented reason
- 6 abstract candidates completed
