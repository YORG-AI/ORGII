# Frontend UI Audit — Work Item Attachment Control

## Scope

The Session creator's Add Work Item action, its start-page integration, the
standalone link-existing flow, and the dedicated Work Item creator. The audit
distinguishes duplicate inline creation from UI that remains reachable through
other Session creator entry points.

## Findings

| Line                                  | Element                             | Verdict          | Reason                                                                                                                                               | Suggested change                                                                |
| ------------------------------------- | ----------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `WorkItemAttachmentControl.tsx:81`    | Inline Work Item creator branch     | fix              | It duplicated the dedicated Work Item creator and became unreachable from the start page after direct navigation was introduced.                     | Remove its imports, draft/save state, callbacks, menu item, and inline panel.   |
| `WorkItemAttachmentControl.tsx:88`    | Attachment mode state               | fix              | The former `create \| link \| null` state retained a one-variant mode abstraction after the create branch was removed.                               | Model only the surviving link panel with `isLinkPanelOpen`.                     |
| `SessionCreatorChatPanelView.tsx:383` | Link panel portal host              | fix              | Start-page and nested creator variants rendered an empty host even when linking was unavailable or the attachment action was hidden.                 | Render the host only for the live link-capable attachment control.              |
| `WorkItemAttachmentControl.tsx:105`   | Link existing Work Item flow        | keep with reason | Global Spotlight, Agent Control, Kanban, and other standalone Session creators do not provide the navigation callback, so linking remains reachable. | Retain the link menu, search, selection, and context projection.                |
| `ChatPanelEmptyContent.tsx:160`       | Dedicated Work Item creator         | keep with reason | This is the canonical Work Item creation UI selected by the start-page create target and is used by both manual and agent creation modes.            | Route Add Work Item to this view; do not delete or duplicate it.                |
| `WorkItemAttachmentControl.tsx:301`   | Direct navigation trigger semantics | fix              | A button that navigates directly should not retain menu-expanded or menu-popup semantics.                                                            | Omit menu ARIA state and dropdown rendering when `onCreateWorkItem` is present. |

## Verdict counts

- fix: 4
- keep with reason: 2
- abstract: 0

## Accessibility and visual-system notes

The direct-navigation variant is now exposed as a plain button rather than a
menu trigger. The standalone variant retains its menu roles and its existing
shared pill surface states. No new visual tokens or arbitrary values were
introduced.
