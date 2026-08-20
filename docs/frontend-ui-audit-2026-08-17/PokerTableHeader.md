# Poker table header

## Scope

Audited the new poker table header controls for shared component usage,
design-token consistency, accessibility basics, and duplicated dropdown
presentation. The configured `frontend-ui-audit` skill file was unavailable at
both repository-documented paths, so this is the repository's established
manual fallback format.

## Findings

| Line                                                     | Element                        | Verdict          | Reason                                                                                                                                                                                            | Suggested change                                                                                                                                          |
| -------------------------------------------------------- | ------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PokerTableHeader.tsx:84`                                | Stakes control                 | fix              | The custom `Dropdown` trigger duplicated selection, chevron, focus, popup-positioning, placeholder, and keyboard behavior already owned by the shared `Select`.                                   | Use controlled `Select` props with shared options, the reusable `placeholder` prop, accessible labeling, and left-aligned automatic-width popup behavior. |
| `PokerTableHeader.tsx:124`                               | Speed control                  | fix              | The hand-built radio menu duplicated shared option rendering, placeholder, and selected-state behavior.                                                                                           | Use a controlled `Select` with the reusable `placeholder` prop, a settings prefix, right alignment, and minimum trigger-width matching.                   |
| `PokerTableHeader.tsx:111`                               | History action                 | fix              | The raw icon button bypassed the shared button sizing, interaction states, and icon-only prop contract.                                                                                           | Use the shared tertiary mini `Button` with `iconOnly`, `aria-label`, and `aria-pressed`.                                                                  |
| `PokerTableHeader.tsx:155`                               | Close action                   | fix              | The raw icon button bypassed the same shared header-action behavior.                                                                                                                              | Use the shared tertiary mini `Button` with `iconOnly` and an accessible name.                                                                             |
| `PokerTableHeader.tsx:84` and `PokerTableHeader.tsx:124` | Drag exclusion wrappers        | keep with reason | `useWindowDrag` does not classify a `role="combobox"` trigger as interactive, so a narrow `data-no-window-drag` wrapper is required to prevent selecting an option from initiating a window drag. | Keep the wrappers until the shared drag hook explicitly recognizes comboboxes.                                                                            |
| `PokerTableHeader.tsx:62`                                | Pending-stakes trigger label   | keep with reason | Stakes changes intentionally take effect at the next hand; the option state must reflect the pending setting while the compact title continues to report the live blinds.                         | Keep `triggerLabel` separate from the selected option label.                                                                                              |
| `PokerTableHeader.tsx:107`                               | Compact hand-number typography | keep with reason | The 12px secondary label matches the existing compact workstation-header scale and is informational rather than an interactive control.                                                           | Consider tokenizing only as part of a broader workstation-header typography sweep.                                                                        |

## Verdict counts

- Fix: 4
- Keep with reason: 3
- Abstract: 0
- Remaining cross-file sweep candidates: 0
