# Test Cases: pendingModeSwitch

## Preconditions

- Pure helpers over `SessionEvent` fixtures.

## Happy Path

| #   | Steps                                            | Expected Result                                              |
| --- | ------------------------------------------------ | ------------------------------------------------------------ |
| 1   | Latest event is unresolved `suggest_mode_switch` | Extractor returns that event's target/reason                 |
| 2   | Token-only unrelated events arrive after         | `pendingModeSwitchEqual` stays true; card does not re-render |

## Edge Cases

| #   | Scenario                | Steps                          | Expected Result        |
| --- | ----------------------- | ------------------------------ | ---------------------- |
| 1   | Event is `processed`    | Scan store                     | Extractor returns null |
| 2   | Optimistic `isResolved` | Atom still has pending payload | Hook hides the card    |

## Acceptance Criteria

- [ ] Mode-switch card does not subscribe to the full events array identity
- [ ] Skip / Switch still hide the card immediately
