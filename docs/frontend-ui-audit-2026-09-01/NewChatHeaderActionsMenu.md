# NewChatHeaderActionsMenu UI audit

| Line                                                                | Element                      | Verdict          | Reason                                                                                                                                              | Suggested change |
| ------------------------------------------------------------------- | ---------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `src/engines/ChatPanel/components/NewChatHeaderActionsMenu.tsx:159` | Quick-actions visibility row | keep with reason | Reuses the shared dropdown control-row token and design-system `Switch`, including an accessible label and stable test selector.                    | None.            |
| `src/engines/ChatPanel/components/NewChatHeaderActionsMenu.tsx:171` | Skills visibility row        | keep with reason | Reuses the same control-row and `Switch` pattern, shares the canonical persisted preference, and retains the product term “Skills” in every locale. | None.            |

Verdict totals: **0 fix**, **2 keep with reason**, **0 abstract**.
