# Searchable dropdown keyboard navigation

## Scope

Audited shared searchable Select/Dropdown controls and custom searchable
droplists for Arrow, Enter, Escape, trigger focusability, and option semantics.

## Findings

| Line                                                                               | Element                       | Verdict          | Reason                                                                                                                                                       | Suggested change                                                                                         |
| ---------------------------------------------------------------------------------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `src/components/Select/index.tsx:220`                                              | Portaled Select search input  | fix              | Focus moves from the trigger into a portal that is its React sibling, so search-field key events never reached the trigger-owned navigation handler.         | Compose Tauri select-all handling with the shared typed navigation handler directly on the search input. |
| `src/components/InlineDropdown/index.tsx:87`                                       | Searchable inline droplist    | fix              | The custom rows were plain divs without option semantics, and the trigger did not opt into keyboard opening, leaving auto-discovery with no selectable rows. | Reuse `DropdownSearch` and `DropdownItem`, and enable trigger keyboard navigation.                       |
| `src/components/Dropdown/index.tsx:455`                                            | Options-mode Dropdown         | keep with reason | The panel remains a logical child of `DropdownTriggerWrapper`, including when portaled, so search-field keys bubble to its typed navigation handler.         | Preserve the wrapper ownership and keep the portal regression test.                                      |
| `src/components/PropertyField/PropertyDropdownField.tsx:263`                       | Property dropdown search      | keep with reason | `useDropdownEngine` auto-navigation listens at document capture and deliberately accepts Arrow/Enter from single-line search inputs.                         | Keep engine-owned navigation; do not add a competing input handler.                                      |
| `src/scaffold/GlobalSpotlight/palettes/WorkspacePalette/WorkspaceDropdown.tsx:557` | Spotlight searchable palettes | keep with reason | These palettes pass explicit `listNavigation` to the engine, whose document-level listener owns navigation after the search input receives focus.            | Keep the explicit list-navigation contract used across workspace, branch, category, and model palettes.  |
| `src/modules/WorkStation/shared/StatusBar/PortsStatusMenu.tsx:204`                 | Ports searchable menu         | keep with reason | Engine auto-discovery finds button/menu rows and forwards Arrow/Enter from its single-line search field.                                                     | Keep the auto-navigation path and selectable row semantics.                                              |

## Summary

- Fix: 2
- Keep with reason: 4
- Abstract: 0
- Remaining cross-file sweep candidates: 0

The configured `frontend-ui-audit` skill file was unavailable in both the
referenced user-global and workspace locations. This report follows the
repository's documented audit table convention and records the scoped
keyboard-navigation sweep directly.
