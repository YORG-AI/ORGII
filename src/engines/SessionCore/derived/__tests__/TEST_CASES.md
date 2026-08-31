# Test Cases: chat transcript structure

## Preconditions

- Helpers run against in-memory `SessionEvent` fixtures; no EventStore or React.

## Happy Path

| #   | Steps                                                       | Expected Result                         |
| --- | ----------------------------------------------------------- | --------------------------------------- |
| 1   | Build a structure key for `[]`                              | Key is `"0"`                            |
| 2   | Grow `displayText` on the last `isDelta` event              | Structure key and version stay the same |
| 3   | Change last event `displayStatus` from running to completed | Version increments by 1                 |

## Edge Cases

| #   | Scenario                             | Steps                                                      | Expected Result                                                         |
| --- | ------------------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Non-streaming last-event text change | Compare two completed events with different `displayText`  | Keys differ; `areChatTranscriptsStructurallyEqual(..., false)` is false |
| 2   | Streaming last-event text change     | Same ids/status, different `displayText`, `streaming=true` | Structural equality is true                                             |

## Error / Degraded States

| #   | Scenario                                         | Steps                                                           | Expected Result                                                   |
| --- | ------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------- |
| 1   | Family streaming snapshot with token-only growth | Push two StreamingSnapshots that only change last `displayText` | `chatEventsForSessionAtomFamily` returns the same array reference |

## Accessibility

- Not applicable (pure derivation, no UI)

## Acceptance Criteria

- [ ] Token-only streaming updates do not bump `sourceVersion`
- [ ] Event id / status / adapter-routing arg changes do bump `sourceVersion`
- [ ] Primary `useChatHistory` reads the session-scoped family, not `derivedSnapshotAtom.version`
