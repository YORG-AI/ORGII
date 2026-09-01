# SpotlightTabs UI audit

| Line                                                                                                       | Element                       | Verdict          | Reason                                                                                                                                                                                                 | Suggested change |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| `src/scaffold/GlobalSpotlight/components/SpotlightTabs.tsx:100`                                            | Pill and attached tab formats | keep with reason | The pill format composes `SegmentedTextPill`; the requested attached format centralizes raised native tab buttons and the continuous divider. Domain consumers provide labels/icons only               | None             |
| `src/scaffold/GlobalSpotlight/components/SpotlightTabs.tsx:29`                                             | Keyboard handling             | keep with reason | A scoped capture listener handles Tab/Shift+Tab, disabled options, wrapping and focused-tab activation before row navigation; composing and system-modified events are ignored                         | None             |
| `src/scaffold/GlobalSpotlight/palettes/BranchPalette/BranchPickerTabs.tsx:18` and `BranchDropdown.tsx:303` | Shared branch consumer        | keep with reason | Branch labels/types remain domain-owned; the shared component replaces branch-specific keyboard code while retaining Ctrl+Tab and ordinary Tab section behavior. The dropdown marks its keyboard scope | None             |

Verdict totals: **0 fix**, **3 keep with reason**, **0 abstract**.

Covered D1–D5. Native tab buttons belong to the shared tab primitive itself; no consumer implements its own tab markup. Colors and spacing use semantic tokens. This extraction is explicitly requested by the user, rather than an unrelated multi-file sweep. The pill format retains `aria-pressed`; attached tabs use `tablist`/`tab`, `aria-selected`, roving focus and a visible keyboard focus ring.

The attached format owns an `mb-2` bottom offset (8px), keeping the first result clear of the divider without per-picker spacing overrides.

Verification: seven shared-tab tests cover disabled-option skipping, reverse/wrap switching, focused activation, Ctrl+Tab compatibility, independent mounted pickers, composition/system shortcuts, selected-tab scrolling, and five mount/unmount cycles. Existing branch palette/dropdown tests pass. Native visual verification was not performed.
