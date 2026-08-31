# Test Cases: questionSignals

## Preconditions

- Pure helpers over `SessionEvent` fixtures.

## Happy Path

| #   | Steps                               | Expected Result                               |
| --- | ----------------------------------- | --------------------------------------------- |
| 1   | Store has a complete ask-user batch | `batches` has one item; `streamingCount` is 0 |
| 2   | Unrelated streaming tokens arrive   | `questionSignalsEqual` stays true             |

## Edge Cases

| #   | Scenario                           | Steps                 | Expected Result                  |
| --- | ---------------------------------- | --------------------- | -------------------------------- |
| 1   | In-flight ask with empty questions | Extract signals       | `streamingCount` is 1            |
| 2   | Local dismiss of a batch           | Filter by dismiss map | Card hides; other batches remain |

## Acceptance Criteria

- [ ] AskQuestionCard does not re-render on every chat token
- [ ] Loading shell still appears while questions stream in
