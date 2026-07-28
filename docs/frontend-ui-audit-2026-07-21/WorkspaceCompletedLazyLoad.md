# Workspace completed lazy load — frontend UI audit

Scope: workspace Work Items status controls, collapsible status sections, deferred Completed feedback, and GitHub status presentation.

| Line / element                                | Element                             | Verdict          | Reason                                                                                                                                                                  | Suggested change                                                           |
| --------------------------------------------- | ----------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `LeadingCells.tsx` GitHub status trigger      | Open / Closed row control           | fix              | GitHub work-item rows now retain the established icon-only property-control density while the shared dropdown keeps the full Open and Closed option labels.             | Keep the source status as row data; only compact its trigger presentation. |
| `PropertyDropdownField.tsx` icon-only trigger | Accessible control name             | fix              | The visual label is intentionally hidden, so the shared trigger now exposes the same label through `aria-label` in addition to its hover title.                         | Keep accessible naming centralized in the shared property field.           |
| `WorkItemSection` expansion callback          | Deferred-section trigger            | abstract         | The existing section owns keyboard/click expansion and now reports that state without moving workspace fetch logic into the shared component.                           | Keep data loading in the workspace caller.                                 |
| `WorkItemsListSurface` section hooks          | Empty/collapsed/placeholder policy  | abstract         | Shared opt-in props support default-collapsed sections, an expansion callback, and shared loading/error placeholders without changing project-page defaults.            | Reuse these hooks for future genuinely deferred status sections.           |
| Workspace Completed section                   | Default collapsed state             | keep with reason | Completed is the expensive terminal bucket and starts collapsed; active work remains immediately visible and expanding Completed is the explicit load signal.           | None.                                                                      |
| Workspace Completed feedback                  | Loading and retry state             | keep with reason | The expanded section uses the shared `Placeholder` component for both debounced loading feedback and an inline retry action.                                            | None.                                                                      |
| Workspace status model                        | GitHub Closed merged into Completed | keep with reason | The workspace projection combines source-specific terminal states without mutating each row's real status, so GitHub status editing and source identity remain correct. | Keep this projection workspace-specific.                                   |

Verdict counts: **fix 2**, **keep with reason 3**, **abstract 2**.

Accessibility check: icon-only status buttons retain an accessible status name; section headers remain keyboard-toggleable and now expose `aria-expanded`; dropdown menu options retain visible labels and native button behavior.

Systematic sweep: all `RowPropertyDropdown` status-trigger logic is centralized in `LeadingCells.tsx`; project-specific list pages keep their current expansion and empty-state defaults because the new list-surface behavior is opt-in.

Validation: focused workspace status-model tests, full TypeScript checking, targeted ESLint, Rust bucket tests, formatting, and whitespace validation pass.
