# Frontend UI Audit — Browser Storage Cleanup

## Scope

The new browser-cache usage row and cleanup action in Monitor → Storage,
including design-system reuse, feedback, disabled/loading behavior, and the
separation between disposable caches and protected user state.

The configured `frontend-ui-audit` skill file was unavailable at both documented
locations, so this report applies the repository's audit format and existing
Settings-section conventions directly.

## Findings

| Line                     | Element                      | Verdict          | Reason                                                                                                                                         | Suggested change                                                                 |
| ------------------------ | ---------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `StorageSection.tsx:299` | Cleanup action lifecycle     | abstract         | The handler delegates inspection and allowlisted deletion to the shared quota utility instead of duplicating storage-key policy in the UI.     | Keep cache ownership and protected-key policy outside the Settings component.    |
| `StorageSection.tsx:401` | Browser cache settings row   | keep with reason | `SectionContainer` and `SectionRow` match the existing Storage layout and give usage plus safely-cleanable bytes the same information density. | Keep the action in Monitor → Storage beside the existing disk-usage controls.    |
| `StorageSection.tsx:409` | Clean up button              | keep with reason | The shared secondary `Button` communicates a safe maintenance action; visible text, icon, loading, and disabled states cover basic a11y.       | Keep the visible label and disable the action when no disposable bytes remain.   |
| `StorageSection.tsx:308` | Success/empty/error feedback | keep with reason | Shared `Message` feedback reports bytes released, an already-clean state, or failure without introducing a parallel notification primitive.    | Keep cleanup result messaging localized and proportional to the nonfatal action. |

## Verdict counts

- fix: 0
- keep with reason: 3
- abstract: 1

## Accessibility and visual-system notes

The action uses the existing Settings row hierarchy, shared button sizing and
tokens, a visible localized label, loading state, and a disabled state when
there is nothing to clean. No arbitrary colors, dimensions, or duplicate
interaction primitives were introduced. The rendered unit test verifies that
the button executes the allowlisted cleanup while protected state remains.
