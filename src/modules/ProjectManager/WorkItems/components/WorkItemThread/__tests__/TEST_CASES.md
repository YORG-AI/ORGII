# Test Cases: WorkItemThread

## Preconditions

- A Work Item can render with `presentation="thread"`.
- Path and property-pill content may each be present or absent.
- To-Do and Agent Workflow retain their existing persistence and orchestration handlers.

## Happy Path

| #   | Steps                                                       | Expected Result                                                                                 |
| --- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Open a Team Inbox Work Item with path and property pills.   | One compact metadata band renders above the thread, with a divider between path and properties. |
| 2   | Inspect To-Do and Agent Workflow.                           | Both use the same radius, border, background, and header-divider treatment.                     |
| 3   | Add or complete a To-Do, then start/open an Agent workflow. | Existing Work Item persistence and canonical Agent behavior remain unchanged.                   |

## Edge Cases

| #   | Scenario          | Steps                                            | Expected Result                                                                                |
| --- | ----------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1   | No header content | Render without path or properties.               | No empty metadata band or divider is mounted.                                                  |
| 2   | One header source | Render with only path, then only properties.     | The available content renders without an orphan divider.                                       |
| 3   | Narrow width      | Resize the detail until property pills overflow. | The metadata band scrolls horizontally while the content remains a single reading column.      |
| 4   | Empty To-Do       | Open a Work Item with no committed To-Dos.       | The shared section shell remains intact and exposes the demand-mounted add action.             |
| 5   | Rapid interaction | Toggle To-Dos and collapse Workflow quickly.     | Each owning component handles its own state; layout primitives introduce no duplicate updates. |

## Error / Degraded States

| #   | Scenario                | Steps                               | Expected Result                                                                          |
| --- | ----------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Read-only item          | Open a standalone Work Item.        | Thread content stays readable and mutation controls remain disabled/absent.              |
| 2   | Failed Work Item update | Trigger an existing update failure. | Existing error handling remains visible; the shared shell does not hide or replace data. |

## Accessibility

- [ ] Section titles label their `<section>` regions.
- [ ] Header and To-Do actions remain keyboard-navigable.
- [ ] Icon-only controls retain translated accessible names.
- [ ] Collapsible Workflow keeps the existing button semantics and focus treatment.

## Acceptance Criteria

- [ ] Team Inbox composes the thread through `WorkItemThreadLayout`.
- [ ] Static thread cards compose through `WorkItemThreadSection`.
- [ ] Collapsible Workflow reuses the same Work Item thread tokens without duplicating collapse state.
- [ ] The ordinary Work Item presentation remains unchanged.
- [ ] No persistence, orchestration, navigation, polling, or subscription ownership moves into the presentation primitives.
