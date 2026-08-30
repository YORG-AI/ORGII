# Test Cases: Comment Anchor Identities

## Preconditions

- ChatView is showing a session whose LiveRegion mounts `SessionCommentsProvider`
- Pipeline chat events are available through `chatEventsForSessionAtomFamily`

## Happy Path

| #   | Steps                                                     | Expected Result                                                                                                 |
| --- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1   | Open a cloud session with existing turns                  | Comment anchors resolve against event id + source; turn chrome can attach                                       |
| 2   | Stream assistant tokens into the last delta event         | Identity list stays referentially stable; comments context consumers do not re-render from `displayText` growth |
| 3   | Complete the assistant turn (new event or `isDelta` ends) | Identity list updates; present-event registry and orphan bucketing refresh                                      |

## Edge Cases

| #   | Scenario                 | Steps                                       | Expected Result                                                        |
| --- | ------------------------ | ------------------------------------------- | ---------------------------------------------------------------------- |
| 1   | Empty transcript         | Open a new session before the first message | Empty identity list; `events` is `null` until snapshot `loadStarted`   |
| 2   | Snapshot not hydrated    | Mount LiveRegion before family cache lands  | Provider receives `events={null}` (presence unknown), not an empty set |
| 3   | Source change on same id | Replay/import remaps a user event source    | Identity inequality triggers rebuild of the source-event id map        |
| 4   | Rapid token burst        | Many streaming envelopes with unchanged ids | Equality holds; no comments-context value churn                        |

## Error / Degraded States

| #   | Scenario               | Steps                      | Expected Result                                                                   |
| --- | ---------------------- | -------------------------- | --------------------------------------------------------------------------------- |
| 1   | Non-cloud session      | Open a local-only session  | Provider still receives identities, but `target` is null so context value is null |
| 2   | Group-chat merged view | `turnAnchorsVisible=false` | Identities may update; turn chrome stays hidden via the existing flag             |

## Accessibility

- [ ] Keyboard-navigable (Tab, Enter, Escape) — unchanged; comments chrome owns focus
- [ ] Screen reader label present — unchanged
- [ ] Focus trap correct (modals/dropdowns) — unchanged

## Acceptance Criteria

- [ ] Token-only `displayText` growth does not change comment-anchor identities
- [ ] Adding or removing an event, or changing `source`, does change identities
- [ ] LiveRegion passes identities (not full `SessionEvent[]`) into `SessionCommentsProvider`
- [ ] Unhydrated snapshots still pass `null` rather than an empty identity list
