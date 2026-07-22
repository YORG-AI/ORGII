# Test Cases: AccountInlineActionsBar Codex Reconnect

## Preconditions

- Open Settings → Integrations → Models & Keys.
- At least one local Codex OAuth account is available.
- The account list has finished loading.

## Happy Path

| #   | Steps                                                 | Expected Result                                                                                       |
| --- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Expand a Codex OAuth account whose status is invalid. | A “Reconnect Codex” button is visible in the account footer.                                          |
| 2   | Activate “Reconnect Codex”.                           | The existing-account repair wizard opens and the embedded Codex login starts automatically.           |
| 3   | Complete ChatGPT login and save.                      | The existing account is updated, returns to Models & Keys, and becomes available to the model picker. |

## Edge Cases

| #   | Scenario                    | Steps                                                            | Expected Result                                                                       |
| --- | --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Healthy Codex OAuth account | Expand an enabled, healthy Codex account.                        | No reconnect button is shown.                                                         |
| 2   | Codex API-key account       | Expand an invalid Codex row authenticated with an API key.       | No OAuth reconnect button is shown; existing edit/removal actions remain available.   |
| 3   | Other invalid provider      | Expand an invalid Claude Code or API-provider account.           | No Codex reconnect button is shown.                                                   |
| 4   | Non-local account           | Inspect an invalid account without local credential material.    | No reconnect button is shown.                                                         |
| 5   | Rapid repeated interaction  | Click the reconnect button repeatedly before navigation settles. | Navigation remains on one repair wizard and does not create duplicate credentials.    |
| 6   | Narrow panel                | Resize the Settings panel to its minimum supported width.        | Footer actions remain usable and the reconnect label does not overlap account status. |

## Error / Degraded States

| #   | Scenario                     | Steps                                                             | Expected Result                                                                                  |
| --- | ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1   | Browser login cancelled      | Open reconnect, then close the embedded browser.                  | No replacement token is saved and the original invalid account remains intact.                   |
| 2   | OAuth login rejected         | Complete login with an upstream authorization error.              | The wizard displays the existing Codex sign-in error and does not create a duplicate account.    |
| 3   | Account removed before click | Remove the credential in another window, then activate reconnect. | The wizard opens in repair mode and reports the missing account without overwriting another row. |

## Accessibility

- [ ] Reconnect is keyboard-navigable with Tab and Enter/Space.
- [ ] The button exposes the localized “Reconnect Codex” accessible name.
- [ ] Focus moves into the existing repair wizard when navigation completes.
- [ ] Embedded login retains its existing focus and Escape/close behavior.

## Acceptance Criteria

- [ ] Only failed local Codex OAuth accounts show “Reconnect Codex”.
- [ ] Activating reconnect passes the existing account ID to the repair route.
- [ ] Successful login updates the existing credential instead of creating a duplicate.
- [ ] Healthy, API-key, non-Codex, and non-local accounts do not show the action.
- [ ] Existing refresh, edit, and remove actions continue to work.
