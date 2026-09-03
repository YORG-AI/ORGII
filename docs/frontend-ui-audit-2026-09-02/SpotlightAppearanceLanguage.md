# Spotlight appearance and language UI audit

| Line                            | Element                            | Verdict          | Reason                                                                                                                                                                                        | Suggested change |
| ------------------------------- | ---------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `GeneralSection.tsx:253`        | Settings language selector options | keep with reason | The existing design-system `Select` remains the owner of dropdown interaction; this change only centralizes its option-label formatting, including the shared `Follow system · English` form. | None.            |
| `GlobalSpotlight/index.tsx:312` | Theme and skin search placeholders | keep with reason | The existing `SpotlightShell` input and action-path state machine continue to own interaction and accessibility; only parameter-specific localized copy was added.                            | None.            |
| `spotlightItemBuilders.ts:180`  | Theme option rows                  | keep with reason | Rows use the shared `SpotlightItem` model, standard Hugeicons, and existing current-selection metadata instead of adding custom controls or styling.                                          | None.            |
| `spotlightItemBuilders.ts:235`  | Grouped skin option rows           | keep with reason | Source headers and options reuse Spotlight's established non-interactive header and selectable-row patterns, with no new raw HTML or hardcoded visual tokens.                                 | None.            |

Verdict totals: **0 fix**, **4 keep with reason**, **0 abstract**.
