# Setup Walkthrough acceptance cases

## Outcome and ownership

- User outcome: reach the first useful surface with the required local/cloud
  configuration proven, not merely visit the final slide.
- Settings owns resumable, secret-free setup progress and the terminal
  `open | completed | dismissed` outcome.
- Key Vault/Rust validation owns credential discovery; setup retains summaries
  only.
- ORG2 Cloud owns identity, membership, repo policy, invites, and server
  enforcement.
- Workspace owns filesystem roots. Project and Work Item remain planning data.

## State machine

| State            | User event                | Guard/postcondition                                                             | Next state             |
| ---------------- | ------------------------- | ------------------------------------------------------------------------------- | ---------------------- |
| Goal             | Select personal/work/team | Goal is non-null                                                                | Tools                  |
| Tools            | Continue                  | Explicit user acknowledgement; detection/import are optional foreground actions | Basics or Organization |
| Organization     | Select/create/join        | Refreshed cloud roster contains selected org                                    | Sharing                |
| Sharing (admin)  | Save policy               | Server accepted repo scopes and sharing floor; sync request drained             | Basics                 |
| Sharing (member) | Verify sync               | Selected org is active; sync enabled and org pass drained                       | Basics                 |
| Basics           | Continue                  | Appearance writes use canonical settings hooks                                  | Tutorial               |
| Tutorial         | Continue                  | Optional tutorial id retained                                                   | Work model             |
| Work model       | Continue                  | Explicit acknowledgement                                                        | Ready                  |
| Ready            | Finish                    | Progress and terminal outcome persist in one write                              | Goal destination       |

## Behavioral matrix

| Case                                                 | Expected result                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New install, personal goal                           | Team-only steps disappear; finish opens the real agent Launchpad.                                                                                                                                                                                   |
| New install, work-management goal                    | Finish opens the existing Work Item creator in Launchpad.                                                                                                                                                                                           |
| No goal selected                                     | Goal choices remain visible; Continue stays disabled and no option appears selected.                                                                                                                                                                |
| Switch goal between personal/work/team               | The sidebar step count changes between six and eight steps; team adds Organization and Team visibility without inserting a checkmark or shifting the goal rows.                                                                                     |
| Goal selection by keyboard                           | Tab reaches each native ActionCard; Enter/Space updates `aria-pressed`, the sidebar step count, and Continue state.                                                                                                                                 |
| Goal layout at a constrained width                   | The single-column goal list remains readable without clipping labels or changing the underlying selected goal.                                                                                                                                      |
| Shared surface consistency                           | Guidance and results use `InlineAlert`; explanatory and readiness rows use `SectionContainer` / `SectionRow` without onboarding-only card skins or glow effects.                                                                                    |
| Shared shell tokens                                  | Sidebar width comes from the main navigation sidebar token, the setup progress indicator uses `ProgressBar`, and shell colors/spacing use the app's semantic Tailwind tokens.                                                                       |
| macOS window controls                                | The brand block starts below the shared native-titlebar inset; traffic lights never touch or overlap the application logo. Windows and Linux add no macOS-only inset.                                                                               |
| Typographic hierarchy                                | Every setup page delegates title, description, icon, width, spacing, and a11y hierarchy to shared `WizardStepContent`; ActionCard/SectionRow retain their canonical title scales.                                                                   |
| Dynamic setup feedback                               | Imported, selected, and verified states expose `role="status"`; operation failures expose `role="alert"`.                                                                                                                                           |
| Team user signed out                                 | Organization step shows a sign-in/register action and cannot advance.                                                                                                                                                                               |
| Existing team membership                             | Selecting the org persists the namespaced sidebar scope and unlocks sharing.                                                                                                                                                                        |
| Create/join double click                             | Only one membership operation is active; authoritative roster convergence is required before success.                                                                                                                                               |
| Invalid/expired invite                               | Error stays inline; org selection and step completion do not change.                                                                                                                                                                                |
| Workspace has no Git remote                          | Scope action explains the blocker; a local path is never used as a shareable scope.                                                                                                                                                                 |
| Admin scope succeeds, floor fails                    | Step remains incomplete and retryable; UI never reports the two-RPC policy as committed.                                                                                                                                                            |
| Organization or policy changes while save is pending | The request may finish for its captured org, but it cannot mark the newer selection verified.                                                                                                                                                       |
| Member path                                          | No admin mutation is offered; one explicit org sync pass is required.                                                                                                                                                                               |
| Codex history import                                 | Only `codex_app` is scanned; changed cache reloads the roster; count is persisted.                                                                                                                                                                  |
| Tool detection contains secrets                      | Setup persists only provider/count/validated count.                                                                                                                                                                                                 |
| Navigate to future step                              | Disabled until preceding visible steps are completed.                                                                                                                                                                                               |
| Dismiss and reopen                                   | Progress remains; Settings menu can reopen the checklist.                                                                                                                                                                                           |
| Setup test shortcut                                  | `⌘⌥O` / `Ctrl+Alt+O` uses the native menu (DOM fallback), atomically resets setup-owned progress/outcome, synchronizes a mounted controller, and opens Goal despite child WebView focus. Keys, orgs, workspaces, and product data remain unchanged. |
| Repeated test shortcut while saving                  | The chord is consumed, but only one settings write and navigation may run; a failed save does not navigate and can be retried.                                                                                                                      |
| Restart during a step                                | Settings-backed progress restores the current visible step.                                                                                                                                                                                         |
| Finish                                               | Progress and outcome persist atomically before navigation.                                                                                                                                                                                          |
| Selected tutorial                                    | Tutorial starts after the Workstation surface mounts.                                                                                                                                                                                               |
| Switch to any supported language                     | Setup sidebar, all goal paths, role labels, tutorial picker, tutorial modal, and every tour step render from that locale without falling back to English.                                                                                           |
| Translation interpolation                            | Step counts, account counts, organization names, and role labels retain the same interpolation variables in every locale.                                                                                                                           |

## Verification

- Unit: `__tests__/flow.test.ts`, `__tests__/setupCommands.test.ts`,
  `__tests__/layoutTokens.test.ts`,
  `__tests__/testShortcut.test.ts`,
  `__tests__/useSyncedSetupWalkthroughProgress.test.ts`,
  `__tests__/i18n.test.ts`, `ProgressBar.test.ts`, setup navigation/settings tests, and
  `settingsAtom.atomic.test.ts`.
- Rendered UI: `tests/e2e/specs/core/setup-walkthrough-ui.spec.mjs` and
  `tests/e2e/specs/core/setup-walkthrough-shortcut-ui.spec.mjs`.
- Static gates: TypeScript typecheck and ESLint over all changed TypeScript/TSX
  files.
- Cloud live behavior continues to use the existing cloud-org and dual-instance
  rendered suites; the onboarding E2E intentionally covers the offline personal
  path deterministically.
