# Codex provider profiles UI audit

| Line                            | Element                     | Verdict          | Reason                                                                                                           | Suggested change |
| ------------------------------- | --------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| `CodexModelSettings.tsx:32`     | Model and token rows        | keep with reason | Reuses Settings SectionRow and SECTION_CONTROL_STYLE, including narrow stacking                                  | None             |
| `CodexModelSettings.tsx:40`     | Manual model input          | keep with reason | Uses the DS Input with an accessible label and a separate request ID                                             | None             |
| `CodexModelSettings.tsx:48`     | Native datalist             | keep with reason | Suggestions remain optional and cannot prevent a manually typed ID; same pattern as Claude mappings              | None             |
| `CodexModelSettings.tsx:66`     | Reasoning selector          | keep with reason | Reuses DS Select; native effort identifiers are kept verbatim because gateways consume them                      | None             |
| `CodexModelSettings.tsx:93`     | Token inputs                | keep with reason | DS numeric fields expose optional values and bounds without new colors or sizing constants                       | None             |
| `ProviderProfileEditor.tsx:73`  | Shared provider-card editor | keep with reason | One production editor owns save/test/apply/restore for all three targets; model controls remain target-specific  | None             |
| `ProviderProfileEditor.tsx:193` | Conflict/installation error | keep with reason | Existing alert semantics and warning token retained in the shared editor                                         | None             |
| `ProviderProfileEditor.tsx:287` | Target-specific model form  | keep with reason | Codex has a default model and optional settings; Claude keeps its mapping table without duplicated editor chrome | None             |

Verdict totals: **0 fix**, **8 keep with reason**, **0 abstract**.

Static actual-component evidence: light/dark and 480px narrow renders in `docs/codex-provider-profiles/`. Rendered interaction tests exercise Codex save/test/apply and discovery cancellation alongside Claude regressions. Native GUI and assistive-technology runtime checks were not run; computer control was not authorized.
