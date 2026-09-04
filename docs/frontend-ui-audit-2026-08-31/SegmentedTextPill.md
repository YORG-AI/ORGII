# SegmentedTextPill UI audit

| Line                                            | Element                                 | Verdict          | Reason                                                                                                                                                                                                | Suggested change                                                                                                             |
| ----------------------------------------------- | --------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/components/SegmentedTextPill/index.tsx:5`  | Per-option metadata                     | fix              | The compact conversation switch needs accessible names for glyph-only options and tooltips over the whole button. These are generic option concerns, not conversation state.                          | Applied: optional `ariaLabel` and `tooltip` fields; only options supplying tooltips instantiate the existing shared Tooltip. |
| `src/components/SegmentedTextPill/index.tsx:56` | Native segment button                   | keep with reason | This is the design-system primitive itself. Native button type, disabled behavior, click forwarding, and pressed state remain intact; Tooltip clones the same button without adding a layout wrapper. | None.                                                                                                                        |
| `src/components/SegmentedTextPill/index.tsx:25` | Established dimensions and theme tokens | keep with reason | Existing small/default sizing and themed backgrounds are unchanged, preserving GUI / TUI, Write / Preview, and other consumers that do not supply the new optional fields.                            | None.                                                                                                                        |

Verdict totals: **1 fix**, **2 keep with reason**, **0 abstract**.

No shared style sweep or unrelated consumer migration is needed. The two optional
fields default to the prior rendering path. The conversation integration tests
exercise tooltip click forwarding and preservation of the same native buttons
across maximize/restore; existing pill tests verify both size variants.

Architecture scope: checked compilation results, reuse, naming, generic/domain
separation, unchanged defaults, and compatibility of existing call sites. No
backend, persistence, IPC, initialization, or resolver behavior changed.

See `ConversationModePill.md` for exact verification commands and limitations.
