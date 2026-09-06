# HarnessConnectionEditor UI audit

| Line                              | Element                                | Verdict          | Reason                                                                                                                                                                      | Suggested change |
| --------------------------------- | -------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `HarnessConnectionEditor.tsx:160` | Contextual labels and help affordances | keep with reason | Reuses the shared `HintWithInfo` component for secondary routing, endpoint, and verification guidance, while keeping the settings row labels concise.                       | None.            |
| `HarnessConnectionEditor.tsx:218` | Inline state and validation messages   | keep with reason | Uses `SectionRow` and shared section-layout tokens so conditional feedback preserves the layout and semantic status/alert roles.                                            | None.            |
| `HarnessConnectionEditor.tsx:323` | Connection actions                     | keep with reason | Uses the shared `Button` primitive and `SECTION_ACTION_GAP_CLASSES`; the nested action grouping is needed to pair verification with its help hint.                          | None.            |
| `HarnessConnectionEditor.tsx:179` | Tooltip content width                  | keep with reason | The 280px cap prevents long credential and routing guidance from creating an unreadable tooltip; it is a local overlay constraint rather than a reusable page-layout token. | None.            |

Verdict totals: **0 fix**, **4 keep with reason**, **0 abstract**.
