# Custom API models UI audit

| Line                              | Element                            | Verdict          | Reason                                                                                                                                             | Suggested change |
| --------------------------------- | ---------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `ApiSetup.tsx:461`                | Manual model section               | keep with reason | Extends the existing ModelsDisplay/ModelTable section and settings spacing rather than introducing a separate model form                           | None             |
| `ApiSetup.tsx:478`                | Manual setup explanation           | keep with reason | Uses the existing text token and all 13 locale resources; explains the difference between saving and successful validation                         | None             |
| `unifiedCustomFlatExtras.tsx:114` | Request ID and display-name inputs | keep with reason | Reuses Input and MODEL_TABLE_CONTROL_SIZE; input names come from localized placeholders, draft identity is explicit                                | None             |
| `modelTableColumnHelpers.tsx:113` | Editable row controls              | keep with reason | Keeps existing icon Select, delete Button and enabled Switch with the shared table sizing                                                          | None             |
| `keyFirstItems.tsx:126`           | Custom model selection             | keep with reason | Reuses Spotlight row styling, shows key-scoped labels and commits the exact ID; synthetic variant controls are omitted for literal Custom API rows | None             |

Verdict totals: **0 fix**, **5 keep with reason**, **0 abstract**.

Reviewed D1–D5 on the changed controls. No multi-file design-system sweep was
identified. Light/dark, narrow, empty, loading and error component previews are
in `docs/custom-api-models`. Native interaction and full app CSS integration were
not verified; static previews are explicitly scoped in their README.
