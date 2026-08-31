# Test Cases: WorkItemThread

## Preconditions

- A Work Item can render with `presentation="thread"`.
- Path and property-pill content may each be present or absent.
- Agent Workflow retains its existing orchestration handlers.

## Happy Path

| #   | Steps                                                       | Expected Result                                                                                                                    |
| --- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Open a Team Inbox Work Item with path and property pills.   | One unframed metadata control row renders above the thread, with no surrounding padding and a divider between path and properties. |
| 2   | Inspect custom properties, sub-items, and Agent Workflow.   | Their icons, rows, and icon-only actions share the same horizontal axes.                                                           |
| 3   | Add a custom property or sub-item, then start an Agent.      | Existing Work Item persistence and canonical Agent behavior remain unchanged.                                                      |
| 4   | Open Discussion, then use Back.                             | The secondary navigation replaces the body in place while the independent metadata header remains unchanged.                       |
| 5   | Scroll a long GitHub Issue or Work Item thread.             | The right-edge trail highlights the current semantic stop; selecting a marker scrolls its activity or section into view.           |

## Edge Cases

| #   | Scenario            | Steps                                                 | Expected Result                                                                                          |
| --- | ------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | No metadata content | Render without path or properties.                    | No empty metadata control row renders; the independent Discussion entry remains available after content. |
| 2   | One header source   | Render with only path, then only properties.          | The available content renders without an orphan divider.                                                 |
| 3   | Narrow width        | Resize the detail until property pills overflow.      | The unframed metadata row scrolls horizontally while the content remains a single reading column.        |
| 4   | Rapid interaction   | Add a sub-item and collapse Workflow quickly.         | Each owning component handles its own state; layout primitives introduce no duplicate updates.           |
| 5   | Work Item switch    | Open Discussion, then select another Work Item.       | The new Work Item starts on its primary body without showing the previous item's Discussion.             |
| 6   | Long activity trail | Open an issue with more than 20 activity stops.       | The trail keeps 20 evenly sampled markers, including the first and final stops.                          |
| 7   | Short thread        | Open a thread that fits without vertical scroll.      | The dedicated trail rail remains visible, including when only one semantic stop is available.            |
| 8   | Narrow thread       | Narrow the thread until its readable content appears. | The same dedicated trail rail remains available without depending on a second container breakpoint.      |
| 9   | Team Inbox item     | Open an assigned Work Item from Team Inbox.           | The canonical thread includes the same always-visible right-side navigation rail.                        |

## Error / Degraded States

| #   | Scenario                | Steps                               | Expected Result                                                                          |
| --- | ----------------------- | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Read-only item          | Open a standalone Work Item.        | Thread content stays readable and mutation controls remain disabled/absent.              |
| 2   | Failed Work Item update | Trigger an existing update failure. | Existing error handling remains visible; the shared shell does not hide or replace data. |

## Accessibility

- [ ] Section titles label their `<section>` regions.
- [ ] Header icon actions remain keyboard-navigable.
- [ ] Icon-only controls retain translated accessible names.
- [ ] Collapsible Workflow keeps the existing button semantics and focus treatment.
- [ ] Discussion and Back use the shared `Button` with visible, translated names and keyboard focus treatment.
- [ ] The navigation trail is a labeled `<nav>`; each marker is a button with section position and `aria-current` on the active stop.
- [ ] Marker previews appear on hover and keyboard focus, and reduced-motion users receive non-animated scrolling.

## Acceptance Criteria

- [ ] Team Inbox composes the thread through `WorkItemThreadLayout`.
- [ ] Static thread cards compose through `WorkItemThreadSection`.
- [ ] Collapsible Workflow reuses the same Work Item thread tokens without duplicating collapse state.
- [ ] Discussion appears after the primary Work Item content; it never shares the property metadata row.
- [ ] The ordinary Work Item presentation remains unchanged.
- [ ] No persistence, orchestration, navigation, polling, or subscription ownership moves into the presentation primitives.
- [ ] GitHub issue activity, local Work Item activity, workflow, output, discussion, and comment destinations contribute semantic trail stops.
- [ ] Trail discovery is mutation-driven, scroll updates are frame-coalesced, and all observers/listeners are disposed with the thread.
