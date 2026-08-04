# Test Cases: Codex Auto-detect Feedback

## Preconditions

- Open **Models & Keys → Add Agent** and select **OpenAI → Codex Subscription → Auto-detect**.
- For successful cases, `~/.codex/auth.json` contains a valid signed-in Codex session.

## Happy Path

| #   | Steps                                                                       | Expected Result                                                                                          |
| --- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Select **Auto-detect**, then choose **Detect**.                             | The button enters a loading state immediately and an informational credential-detection message appears. |
| 2   | Wait while the local credential is validated.                               | Feedback changes to model-catalog loading; the button remains disabled.                                  |
| 3   | Let detection finish successfully.                                          | A persistent success alert shows that Codex connected and reports the discovered model count.            |
| 4   | When multiple credentials are found, choose a valid credential and confirm. | Selection feedback is shown, then catalog loading and the final success result appear.                   |

## Edge Cases

| #   | Scenario                   | Steps                                                                 | Expected Result                                                                  |
| --- | -------------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Empty model catalog        | Detect a valid credential whose catalog returns no models.            | Detection still ends visibly as connected and reports 0 available models.        |
| 2   | Multiple credentials       | Detect an OAuth credential and an API key together.                   | The credential picker opens and feedback states how many credentials were found. |
| 3   | Rapid repeated interaction | Double-click **Detect** while detection starts.                       | The loading/disabled button prevents a second user-triggered run.                |
| 4   | Retry after failure        | Cause a failure, restore the credential, then click **Detect** again. | The old error is cleared immediately and replaced by progress, then success.     |

## Error / Degraded States

| #   | Scenario                      | Steps                                                            | Expected Result                                                                                               |
| --- | ----------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 1   | No local credential           | Remove or rename the local Codex auth file and click **Detect**. | A persistent danger alert explains that no credential was detected and offers the existing recovery hint.     |
| 2   | Invalid or expired credential | Detect an expired local session.                                 | A persistent danger alert shows the backend validation reason.                                                |
| 3   | Model catalog failure         | Make model discovery reject after credential detection succeeds. | Loading ends and a persistent danger alert shows the rejection reason; no unhandled rejection is left behind. |
| 4   | Invalid credential selection  | Confirm without a valid selected credential.                     | A persistent danger alert states that no valid credential was selected.                                       |
| 5   | Hung model discovery          | Prevent the model-catalog RPC from settling for 30 seconds.      | Loading ends at the deadline and a persistent timeout error invites retry.                                    |

## Accessibility

- [x] The Detect button is keyboard-navigable with Tab and Enter/Space.
- [x] Progress and success feedback use a `status` live-region role.
- [x] Failure feedback uses an `alert` role and is dismissible.
- [x] The existing credential-selection modal remains keyboard reachable.

## Acceptance Criteria

- [x] Clicking Detect produces immediate visible feedback.
- [x] Credential discovery and model-catalog loading are distinguishable states.
- [x] Success remains visible and includes the discovered model count.
- [x] Empty, validation, RPC, and catalog failures remain visible with a reason.
- [x] Retrying clears stale failure feedback before the new attempt.
- [x] Model-catalog rejection is awaited and handled by the detection flow.
- [x] Model-catalog discovery cannot leave the UI loading beyond 30 seconds.
