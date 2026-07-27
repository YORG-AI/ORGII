# Chat panel initial-loading UI audit

**Scope:** Initial content loading when a chat-pane page opens. Loading states
inside menus, modals, cards, action buttons, and active operations are excluded.

**Summary:** 4 fix, 1 keep with reason, 0 new abstractions. Initial page loading
reuses the existing text-free `ChatLoadingBlock` primitive.

| Line                                                  | Element                                 | Verdict          | Reason                                                                                                   | Suggested change                                       |
| ----------------------------------------------------- | --------------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `ChatHistory/ActivityRouter.tsx:265`                  | Synthetic `id: "loading"` history event | fix              | Initial history hydration could route its translated observation through the assistant-message renderer. | Render `ChatLoadingBlock` before normal event routing. |
| `panels/ProjectPanelView.tsx:535`                     | Project overview initial loader         | fix              | Initial page content used the text-bearing shared placeholder.                                           | Use `ChatLoadingBlock`.                                |
| `panels/ProjectPanelView.tsx:560`                     | Project work-items page loader          | fix              | Page content used the text-bearing shared placeholder.                                                   | Use `ChatLoadingBlock`.                                |
| `panels/CloudOrgPanelView/index.tsx:95`               | Cloud-org initial loader                | fix              | Initial page content used the text-bearing shared placeholder.                                           | Use `ChatLoadingBlock`.                                |
| `ChatHistory/components/ChatHistoryEmptyState.tsx:34` | Empty-history initial loader            | keep with reason | This path already uses `ChatLoadingBlock` for loading, projection, and grace-window states.              | Keep the shared block.                                 |
