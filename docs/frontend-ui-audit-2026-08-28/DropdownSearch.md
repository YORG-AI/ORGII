# DropdownSearch UI audit

Scope: consolidate dropdown search inputs behind the existing `DropdownSearch`
design-system component while preserving each caller's input type, label,
focus behavior, keyboard navigation, and domain-specific leading content.

| Line                                                                    | Element                               | Verdict          | Reason                                                                                                                                                                  | Suggested change                                                                               |
| ----------------------------------------------------------------------- | ------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 14 call sites; see sweep inventory                                      | Raw dropdown search rows              | fix              | Each site rebuilt the same tokenized wrapper, search icon, input, pointer guard, and Tauri select-all behavior even though `DropdownSearch` already owned that pattern. | Completed: extend the shared component narrowly and replace every matching raw implementation. |
| `src/components/Dropdown/DropdownHeader.tsx:33`                         | Compositional dropdown header wrapper | keep with reason | This is a shared header scaffold whose children may be a search field or arbitrary header content; it is not a duplicate text input.                                    | None. Keep it compositional.                                                                   |
| `src/scaffold/ContextMenu/variants/TextSelectionDropdown/index.tsx:136` | Session-selector back/title row       | keep with reason | The row contains navigation and a title, not a search input. Replacing it with `DropdownSearch` would give a non-input header input semantics.                          | None. Keep the header row.                                                                     |

Verdict totals: **1 fix**, **2 keep with reason**, **0 abstract**, **0 watch**.

## Sweep inventory

The consolidation replaced 14 raw input rows:

- `src/components/Dropdown/DropdownOptionsContent.tsx:51`
- `src/components/Select/index.tsx:391`
- `src/engines/ChatPanel/InputArea/components/PinnedActionsBar/PinActionsPanel.tsx:321`
- `src/engines/ChatPanel/InputArea/components/SlashCommandPortal/SlashCommandMenu.tsx:287`
- `src/features/SessionCreator/components/WorktreeSourceSelectorViews.tsx:396`
- `src/modules/MainApp/AgentOrgs/config/shared/SubAgentsEditor.tsx:151`
- `src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/tabs/SourceControlScopeToolbar.tsx:283`
- `src/modules/WorkStation/TabContent/renderers/CliAgentHeaderSwitcher.tsx:97`
- `src/modules/WorkStation/shared/StatusBar/PortsStatusMenu.tsx:333`
- `src/modules/shared/layouts/blocks/SettingsBreadcrumb/index.tsx:289`
- `src/scaffold/GlobalSpotlight/palettes/BranchPalette/BranchDropdown.tsx:266`
- `src/scaffold/GlobalSpotlight/palettes/DispatchCategoryPalette/DispatchCategoryDropdown.tsx:231`
- `src/scaffold/GlobalSpotlight/palettes/UnifiedModelPalette/UnifiedModelDropdown.tsx:476`
- `src/scaffold/GlobalSpotlight/palettes/WorkspacePalette/WorkspaceDropdown.tsx:650`

After the sweep, `DROPDOWN_CLASSES.searchInput` is referenced only by
`DropdownSearch`; 18 production call sites consume the shared component.

## Architecture audit

Acceptance criteria:

- A single component owns dropdown search input chrome and behavior.
- Every matching raw implementation is migrated in the same change.
- Caller-specific keyboard navigation, input type, refs, labels, disabled
  state, focus, test markers, and leading content remain expressible.
- Non-input headers are not forced through an input abstraction.

| Layer                                     | Coverage                                                                                          | Verdict                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness                | `pnpm run typecheck`, focused Vitest, and ESLint over every changed TypeScript file               | Pass.                                                                                                                                               |
| 2. Dead code and structural deduplication | Swept `DROPDOWN_CLASSES.searchInput` and `DROPDOWN_CLASSES.searchContainer` across `src/**/*.tsx` | The input style has one owner; only two intentional non-input header wrappers remain outside it.                                                    |
| 3. Naming consistency                     | Reviewed the component name and new prop names across all consumers                               | `DropdownSearch`, `leading`, `containerClassName`, and `testId` describe their roles without domain terminology.                                    |
| 4. Semantic overloading                   | Compared search input rows with the two remaining header rows                                     | Input behavior is centralized; non-input headers remain explicitly documented exceptions.                                                           |
| 5. Default branches                       | Reviewed default icon, input type, search attributes, and pointer-guard branches                  | Omitted `leading` means the standard icon; `null` explicitly means no leading content. Migrated callers pin `type` to preserve prior DOM semantics. |
| 6. Cross-domain leakage                   | Inspected shared component imports and props                                                      | No feature, workspace, session, or model concepts leak into the component.                                                                          |
| 7. New-developer confusion                | Reviewed the public interface, example, and exceptional call sites                                | The component owns search behavior; callers supply only value and genuine variations.                                                               |
| 8. Wire protocol and serialization        | No network, IPC, persistence, or serialized payload changes                                       | Not applicable.                                                                                                                                     |
| 9. Init parity                            | No initialization or alternate entry-point changes                                                | Not applicable.                                                                                                                                     |
| 10. Resolver symmetry                     | No resolver or fallback-chain changes                                                             | Not applicable.                                                                                                                                     |

No React performance methodology was applied because this is a structural UI
deduplication with no runtime-performance claim or subscription/lifecycle
change.
