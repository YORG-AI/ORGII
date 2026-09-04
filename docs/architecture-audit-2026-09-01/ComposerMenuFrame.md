# Composer menu ownership and frame consolidation audit

Date: 2026-09-01. Scope: the `+`, `@`, and `/` menus in the main chat input, session creator, and project/work-item composers.

## Outcome

The composer has two explicit interaction domains:

- `+` and `@` render the same `ContextMenuPortal` and results-only `ContextMenu`. The composer remains focused and owns the inline query: `+` starts a programmatic mention without inserting `@`, while typed `@` starts the same query session with a visible trigger character.
- `/` renders the separate, skills-only `SlashCommandPortal`. It is the only one of these three triggers that reaches the lazy installed-skills cache/scan path.

`useExclusiveComposerMenuState` stores one active value (`context`, `slash`, or `null`) for both main composer state paths. Opening either menu atomically replaces the other. The contenteditable and Markdown editor trigger state follows the same invariant and closes the previous trigger before activating the next one.

Selecting Upload, a mode, or a context result consumes the transient inline `@` token when present, so keyboard and pointer openings leave the same draft state. All hosts use the shared above-input frame from `INPUT_AREA_MENU_FRAME`.

## Completion checklist

- [x] Manual `+` and typed `@` render the same component and rows
- [x] The dropdown contains no search input; both openings keep focus and query text in the composer
- [x] Up, Down, Tab, Enter, Right, Left, and Escape follow one navigation implementation
- [x] Context and slash menus cannot be visible simultaneously
- [x] Mode changes are available from both `+` and `@`
- [x] Upload is available from both `+` and `@` when the host permits attachments
- [x] `/` accepts skills only; its dormant Upload, Mode, action, and tool branches are deleted
- [x] `+` and `@` do not prefetch or scan installed skills
- [x] Main input, session creator, and project/work-item composers follow the same ownership model

## Entry-point parity

| Entry point                  | Manual `+`                                              | Typed `@`                                        | Typed `/`                                    | Skills scan owner                    |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------- | ------------------------------------ |
| Main `InputArea`             | Starts programmatic inline mention; composer owns query | Starts typed inline mention; composer owns query | Replaces context with skills-only slash menu | `useSlashCommand.handleSlashCommand` |
| Session creator `EditorArea` | Starts programmatic inline mention; composer owns query | Starts typed inline mention; composer owns query | Replaces context with skills-only slash menu | `useSlashCommand.handleSlashCommand` |
| Project/work-item composer   | Starts editor-owned inline mention                      | Starts the same editor-owned inline mention      | Replaces context with skills-only slash menu | `useSlashCommand.handleSlashCommand` |

## Call paths

```text
manual + ─ programmatic inline mention ─┐
                                       ├─ composer query ─ ContextMenuPortal ─ results-only ContextMenu
typed @ ─── typed inline mention ───────┘                         │
                                                                 ├─ row/file filtering
                                                                 ├─ Upload / mode / context selection
                                                                 └─ shared keyboard navigation

context / slash activation ─ useExclusiveComposerMenuState ─ exactly one visible menu
typed / ─ useSlashCommand ─ lazy skill prefetch ─ SlashCommandPortal (skills only)
```

## Term ownership

| Term           | Meaning                                                     | Owner                                      |
| -------------- | ----------------------------------------------------------- | ------------------------------------------ |
| Inline mention | Composer/editor query episode opened by `+` or `@`          | `ComposerInput` / `MarkdownTextareaEditor` |
| Context menu   | Results for Upload, modes, mentions, and context sources    | `ContextMenu`                              |
| Slash menu     | Skills invoked from a `/` token                             | `SlashCommandPortal`                       |
| Active menu    | Mutually-exclusive visibility state, not a pair of booleans | `useExclusiveComposerMenuState`            |

## Architecture methodology coverage

| Layer                       | Coverage / result                                                                                                                                                                                               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 — Compilation             | Repository TypeScript compilation passes; no Rust code is involved                                                                                                                                              |
| 2 — Dead code / duplication | Deleted dropdown search ownership, independent visibility booleans, slash Upload/Mode/action flyouts, plus-specific opening state, the duplicate session-creator dropdown, and duplicate project upload handoff |
| 3 — Naming                  | `ContextMenu` now explicitly documents the shared `+` / `@` contract; slash types describe only skills behavior                                                                                                 |
| 4 — Semantic overloading    | The composer owns query/input semantics; context and slash menus own only their distinct result domains, as recorded in the term table                                                                          |
| 5 — Defaults                | No catch-all/default transition can show both menus: opening one writes its explicit union variant; closing an inactive menu preserves the active variant                                                       |
| 6 — Cross-domain leakage    | `ComposerBar` only requests the shared context menu; it does not know about skill scans, slash entries, or project upload inputs                                                                                |
| 7 — New-developer clarity   | `+` and `@` converge at an inline mention and `ContextMenuPortal`; `/` converges at the skills-only portal; visibility has one named source of truth                                                            |
| 8 — Wire protocol           | Not applicable: no persistence, IPC, request, or serialized payload changed                                                                                                                                     |
| 9 — Entry-point parity      | Swept main input, session creator, project/work-item editor, both editor implementations, imperative APIs, and browser helpers; the parity matrix records the result                                            |
| 10 — Resolver symmetry      | Both visibility setters use the same union transition and stale closes preserve the currently active opposite menu; no multi-source data resolver changed                                                       |

## Performance guard

| Subsystem             | Trigger frequency             | Retained state / work                                           | Cancellation / bound                                                                      | Verification result                                   |
| --------------------- | ----------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Shared menu filtering | Per composer-query keystroke  | In-memory filtering over fixed mode/context/custom-mention rows | Ends on unmount; no timer or subscription                                                 | Accepted by code trace and focused component test     |
| Main-menu file search | Debounced per non-empty query | One async result list, capped at 20                             | `LatestRequestGuard` invalidates stale queries/unmount; debounce cancellation is retained | Accepted by lifecycle trace; no runtime speedup claim |
| Installed skills      | Typed `/` only                | Existing bounded per-scope cache                                | Existing cache bound/cancellation unchanged; `+` / `@` have no call path                  | Confirmed by repository ownership sweep               |

No polling, worker, stream, subscription, pagination loop, or unbounded cache was introduced. Virtualization remains unnecessary for the fixed menu rows and the file result cap of 20; this change makes no measured runtime-performance claim.

## Verification

- `pnpm exec tsc --noEmit --pretty false` — passed with no diagnostics
- Focused ESLint across the changed menu, composer-host, editor API, and test surface — passed with zero warnings
- Focused Vitest run — 9 files and 26 tests passed, including composer-owned menu search, ArrowDown/Enter mode selection, exclusive visibility transitions, editor trigger switching, and skills-only slash projection
- `node --check` across the updated composer E2E spec and three affected helpers — passed
- `git diff --check` — passed
- Repository sweeps found no remaining plus-source state, inline-search branch, slash mode option, manual project upload handoff, or plus-owned skill scan
- The rendered WDIO scenario was not run because desktop UI control requires explicit user opt-in in this workspace
