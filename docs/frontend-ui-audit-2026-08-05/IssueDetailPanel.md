# Frontend UI Audit — Issue Detail Thread

## Scope

Dead-code cleanup around `IssueDetailPanel`, `GitHubIssueThreadSurface`,
`WorkItemThreadSurface`, and `IssueTimelineItems`. The removed paths had no
production caller, so this audit does not introduce a rendered visual change.

## Findings

| Line                                 | Element                         | Verdict          | Reason                                                                                                                           | Suggested change                                                                |
| ------------------------------------ | ------------------------------- | ---------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `IssueDetailPanel.tsx:23`            | Detail-panel props              | fix              | `showBackTitleHeader`, `backLabel`, `contentPadding`, and `onClose` only supported an unreachable alternate header/padding path. | Remove the props and their no-op caller arguments.                              |
| `IssueDetailPanel.tsx:35`            | Issue state helpers             | fix              | `IssueStateIcon` and `getIssueStateClassName` are local implementation details with no external consumer.                        | Keep the helpers private to the module.                                         |
| `IssueDetailPanel.tsx:174`           | Canonical issue thread          | keep with reason | The live body delegates to the shared Work Item thread, preserving the Inbox composition and design-system property controls.    | Keep the shared surface as the sole issue-body renderer.                        |
| `IssueDetailPanel.tsx:184`           | Comment footer spacing          | keep with reason | All production entries use the established `px-4` footer spacing; the removed `px-0` variant had no caller.                      | Keep the single established spacing path.                                       |
| `GitHubIssueThreadSurface.tsx:12`    | Adapter props and documentation | fix              | The props type is module-local, and the prior comment omitted the supported assignee field.                                      | Keep the type private and document repository, status, and assignee accurately. |
| `WorkItemThreadSurface/index.tsx:18` | Thread-surface props            | fix              | The props type is consumed only by its defining component and was unnecessarily public.                                          | Keep the props type private until an external type consumer exists.             |
| `IssueTimelineItems.tsx:16`          | Timeline exports                | fix              | The props type and default export had no consumers; callers use the named renderer.                                              | Retain only the named `IssueTimelineItems` export.                              |
| `components/index.ts:15`             | GitHub mapping barrel export    | fix              | Production uses the mapper inside its defining module and its unit test imports directly; the barrel export had no consumer.     | Remove the redundant barrel re-export.                                          |

## Verdict counts

- fix: 6
- keep with reason: 2
- abstract: 0

## Accessibility and visual-system notes

The live controls remain the existing shared `Button`, `WorkItemProperties`,
and activity-timeline components. No focus order, semantics, color tokens,
responsive behavior, or visible state was changed by this cleanup.
