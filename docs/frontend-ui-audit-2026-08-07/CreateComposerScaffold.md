# Frontend UI Audit — Create Composer Scaffold

## Scope

Create Project and Create Work Item manual/Agent composer consistency,
including title typography, composer structure, pinned property actions,
editor affordances, submit controls, and Chat Panel composition.

## Findings

| Line                               | Element                                                             | Verdict          | Reason                                                                                                                                                  | Suggested change                                                                                |
| ---------------------------------- | ------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `CreateComposerScaffold.tsx:18`    | Shared title input                                                  | fix              | Project and Work Item used separate ghost-input markup, and the title inherited a smaller/heavier input preset than the 14px normal-weight editor body. | Share one title component and explicitly match the body typography.                             |
| `CreateComposerScaffold.tsx:40`    | Header, divider, pinned actions, centered launcher, and Agent frame | abstract         | These layout fragments were duplicated in both create flows and would otherwise drift together.                                                         | Keep the presentation-only fragments in the shared scaffold.                                    |
| `CreateComposerScaffold.tsx:136`   | Manual composer shell                                               | abstract         | Both flows need the same `ComposerShell`, `ComposerBar`, file picker, mention/skills triggers, overflow behavior, and responsive width contract.        | Share the shell and pass entity-owned fields and actions as content.                            |
| `CreateProjectView/index.tsx:379`  | Project composer content                                            | fix              | Create Project previously used a different box hierarchy and an extra brief field, so it did not match Create Work Item.                                | Use the scaffold with title plus one description editor; keep Project draft/save logic local.   |
| `CreateWorkItemView/index.tsx:261` | Work Item composer content                                          | abstract         | Work Item contained the reference markup and editor-wiring code that Project needed to reproduce.                                                       | Consume the same scaffold while keeping Work Item properties and creation behavior local.       |
| `ChatPanelEmptyContent.tsx:233`    | Agent Project composer                                              | fix              | Project fields previously rendered as a separate strip above Session Creator, unlike the Work Item Agent flow.                                          | Inject the shared Project header and pinned actions through the existing Session Creator slots. |
| `ChatPanelStartPage.tsx:76`        | Manual/Agent mode toggle                                            | abstract         | Project and Work Item require the same mode label, icon, pressed state, and leading separator.                                                          | Share one Start Page toggle presentation and pass each entity's controlled state.               |
| `ChatPanelStartPage.tsx:389`       | Project mode control                                                | fix              | Project Agent state existed but had no user-facing switch; without separation it would also merge visually with the project-type selector.              | Show the shared toggle for the Project target with a dedicated separator on its left.           |
| `LaunchButton.tsx:23`              | Composer submit action                                              | keep with reason | The established icon button already provides native semantics, accessible naming, loading/disabled states, and shared input-area tokens.                | Keep the shared button and allow a host-specific test id.                                       |
| `CreateProjectView/index.tsx:365`  | Project property controls                                           | keep with reason | Existing Select and property-field components already supply the design-system interactions needed by the pinned-actions slot.                          | Keep entity-specific controls composed inside the shared slot.                                  |

## Verdict counts

- fix: 4
- keep with reason: 2
- abstract: 4

## Accessibility and visual-system notes

The shared title remains the existing native ghost Input and preserves its
placeholder behavior, with the same 14px normal-weight typography as the
editor body. Mode controls expose their selected state with `aria-pressed`, and
submit actions remain native buttons with localized accessible names and
disabled/loading states. Existing Input, Select, property-field, rich-editor,
composer, and detail-panel tokens are reused; no parallel interactive
primitive or arbitrary color was added. Centered launchers retain overflow
handling, and pinned actions remain horizontally scrollable at narrow widths.
