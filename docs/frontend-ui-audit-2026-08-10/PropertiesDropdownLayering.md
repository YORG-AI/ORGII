# Properties Dropdown Layering

The configured `frontend-ui-audit` skill was unavailable, so this focused fallback audit follows the repository's required verdict table.

| Line                              | Element                      | Verdict          | Reason                                                                                                                               | Suggested change                                                              |
| --------------------------------- | ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `PropertyFieldEditable.tsx:229`   | `SearchableDropdown`         | abstract         | Every property menu needs the same escape from rounded, scrollable trail surfaces while retaining trigger-width positioning.         | Portal the shared menu and calculate its fixed width from the trigger anchor. |
| `DropdownSearch.tsx:69`           | `DropdownSearch` placeholder | fix              | The English fallback bypasses localization and callers duplicate increasingly specific labels.                                       | Default to `common:actions.search`.                                           |
| `Select/index.tsx:395`            | Select search input          | fix              | The shared Select still uses the longer “Search…” placeholder.                                                                       | Use the same localized concise Search action.                                 |
| `ProjectOrganizationField.tsx:30` | Organization dropdown        | keep with reason | It already uses shared property-row and searchable-menu primitives; once the shared menu portals, no field-specific layer is needed. | Keep the field composition and remove its English default placeholder.        |

## Verdict counts

- Fix: 2
- Keep with reason: 1
- Abstract: 1
