# TeamInboxDetailLayout UI audit

| Line                           | Element        | Verdict          | Reason                                                                                                                                                                                              | Suggested change |
| ------------------------------ | -------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `TeamInboxDetailLayout.tsx:52` | Header actions | keep with reason | Read, unread, auxiliary, and open actions all use the shared `TeamInboxHeaderIconAction`, which owns the design-system button and toolbar tooltip treatment.                                        | None.            |
| `TeamInboxDetailLayout.tsx:95` | Detail shell   | keep with reason | Reuses `DetailPanelContainer`, `PanelHeader`, and the shared header-padding token; the remaining wrapper only establishes the flex and container-query boundary required by nested detail surfaces. | None.            |

Verdict totals: **0 fix**, **2 keep with reason**, **0 abstract**.
