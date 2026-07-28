# E2E Audit — Cloud Dual Instance

Date: 2026-07-21

Scope: `tests/e2e/specs/core/cloud-dual-instance-ui.spec.mjs`, its dual harness/driver, and
the Tauri E2E bootstrap helpers changed by PR #482.

## Verdict

**Pass for merge with two explicit environment limitations.** The rendered suite covers the
two-account production UI and has no remaining helper-driven behavior path. This shell has no
live `E2E_CLOUD_*` service/password credentials, so the full automated cloud suite was not
replayed in this final audit. The PR's earlier packaged build was exercised through the real
Windows UI; both final-head executables compiled, but Windows Smart App Control rejected the new
unsigned files before process creation. The suite continues to skip loudly when credentials are
unavailable, and this report does not claim a final-head rendered pass.

## Behavior-path audit

| Scenario/action            | Before                           | After                                          | Verdict                                                                         |
| -------------------------- | -------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------- |
| Agent selection            | page-script `.click()`           | WebDriver element click                        | valid rendered behavior                                                         |
| Project context menu       | synthetic `contextmenu` dispatch | WebDriver right-click                          | valid rendered behavior                                                         |
| Session comment submit     | page-script click                | WebDriver click after enabled-state inspection | valid rendered behavior                                                         |
| Address Comments selection | page-script click                | WebDriver click                                | valid rendered behavior                                                         |
| Repo-scope selection       | page-script click                | WebDriver click                                | valid rendered behavior                                                         |
| Comment reply submit       | page-script click                | WebDriver click after enabled-state inspection | valid rendered behavior                                                         |
| Auth/org/session seeds     | E2E bootstrap/driver             | unchanged                                      | setup only; not the user behavior under assertion                               |
| `cloudRunSyncPass`         | explicit pass trigger            | unchanged                                      | timer acceleration only; assertions still observe production stores/rendered UI |
| Roster/presence inspectors | read-only helpers                | unchanged                                      | diagnostics only; failures still throw                                          |

## Stability and isolation checks

- OAuth-live selects one explicit secondary account from the already isolated primary home.
- One OAuth refresh chain is never shared by two running applications.
- Secondary credentials are written atomically and token rotations merge back on teardown.
- Primary and instance2 use different Tauri identifiers, ports, data homes, session databases,
  diagnostics endpoints, and external-history homes.
- Failure diagnostics add roster/presence evidence without weakening or replacing assertions.
- No `.skip` exists inside the scenario flow; only the deliberate whole-suite credential guard
  logs `[cloud-dual-e2e] SKIP` when live cloud configuration is absent.
- Direct `webdriverio` dependency is represented by exactly three lockfile importer lines;
  `pnpm --dir tests/e2e install --frozen-lockfile --ignore-scripts` passes.

## Verification

- `node --check tests/e2e/specs/core/cloud-dual-instance-ui.spec.mjs`: pass.
- Synthetic action sweep (`dispatchEvent`, page-script `.click()`): no behavior-path hits remain.
- Earlier PR-branch packaged dual-instance real UI/memory smoke: pass; detailed measurements are in
  `docs/org2-performance-guard-2026-07-21/SessionSharingOrg2Cloud.md`.
- Final-head dual build: both executables compiled and copied with matching hashes; UI launch was
  blocked by Windows Code Integrity event 3077, so no final-head rendered result is claimed.
- Full automated live-cloud suite: not run in this shell because the required cloud credentials
  are absent; this is not recorded as a passing run.
