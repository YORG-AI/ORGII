# PR #610 Discussion Channels — Dual-Instance Verification

**Date:** 2026-07-30

**Build under test:** `pnpm run tauri:build:fast:dual`

**Identities:** main instance (channel manager) and ORG2 Instance 2 (org admin)

**Workspace:** `CU Vanta Shares 0721`

**Final verdict:** pass for the PR #610 discussion-channel lifecycle matrix below; all temporary cloud rows were permanently deleted

## Environment isolation

| Surface         | Main                                       | Instance 2                                      | Verdict |
| --------------- | ------------------------------------------ | ----------------------------------------------- | ------- |
| Executable      | `src-tauri/target/dev-build/org2-main.exe` | `src-tauri/target/dev-build/org2-instance2.exe` | pass    |
| Tauri identity  | primary identity                           | `yorg.orgii.instance2`                          | pass    |
| IDE/proxy ports | 13847 / 17888                              | 13848 / 17889                                   | pass    |
| Settings root   | default ORGII root                         | `.orgii-instance2`                              | pass    |

Both rebuilt processes were launched simultaneously, remained independently
signed in, and displayed the same organization without port or settings
collisions.

## Current-code lifecycle matrix

| Scenario                  | Sender evidence                                                              | Receiver evidence                                                                                                                                                                                                                                     | Outcome        |
| ------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Public create             | Main created `audit-610-public-118207`; row appeared immediately.            | In the first build, receiver needed a visibility transition. After the focus-recovery fix and rebuild, Instance 2 was blurred for more than 45 seconds, then displayed the row about 2.3 seconds after real focus returned, without minimize/restore. | pass after fix |
| Rename with open tab      | Main opened the channel and renamed it to `audit-610-renamed-118207`.        | Main sidebar, channel header, composer context, and cached open-tab payload converged in about 1.7 seconds; Instance 2 converged on focus.                                                                                                            | pass after fix |
| Archive/unarchive         | Main archived and unarchived the public channel.                             | Archived channel remained navigable/readable rather than being treated as revoked.                                                                                                                                                                    | pass           |
| Private create            | Main created `audit-610-private-118207` and invited the Instance 2 identity. | Instance 2 could see and open the private channel after authoritative catch-up.                                                                                                                                                                       | pass           |
| Membership revocation     | Main removed the Instance 2 member while its private channel tab was open.   | Receiver sidebar row and open tab both disappeared automatically in about 21 seconds without a manual visibility transition.                                                                                                                          | pass           |
| Membership restore        | Main re-added the Instance 2 identity for cleanup.                           | Receiver regained access after authoritative catch-up and could administer the row.                                                                                                                                                                   | pass           |
| External permanent delete | Instance 2 permanently deleted private and public temporary channels.        | Main converged after authoritative catch-up; the rebuilt run removed both the public sidebar row and already-open tab about 2.5 seconds after real focus returned.                                                                                    | pass after fix |
| Stale channel dialog      | First run exposed a channel-bound dialog left open after external delete.    | The rebuilt implementation derives settings/members/archive/delete dialogs closed when the authoritative list no longer contains their channel; focused component coverage proves this boundary.                                                      | pass after fix |
| Cleanup                   | Admin UI showed neither temporary channel after deletion.                    | Main authoritative refresh also showed neither row or tab; both app processes were then closed.                                                                                                                                                       | pass           |

## Realtime and recovery observations

- The first main-instance log showed an initial `CHANNEL_ERROR` / `TIMED_OUT`
  sequence and later recovered to `SUBSCRIBED`; Instance 2 subscribed directly.
- Normal `CLOSED` teardown is no longer promoted to a consumer warning. Raw
  transport diagnostics remain the owner of error/time-out detail.
- Positive receiver state, not absence of warnings, was used as the pass
  criterion for create, revoke, restore, rename, and delete.
- The first run's missed create/rename/add/delete display updates established a
  concrete recovery gap. The rebuilt run proved the new focus-regain recovery
  after the realtime blur grace had elapsed.

## Evidence limits

- The configured machine did not expose the service-key ledger needed to query
  discussion-channel backing rows directly, so cloud ground truth was verified
  through both authenticated UIs plus client logs. No database-ledger claim is
  made.
- The session-sharing lifecycle cells (`/compact`, imported-history cache
  rebuild, and fork-on-write) from the dual-instance skill are not applicable
  to discussion-channel CRUD and membership.
- Screenshots were inspected live but not committed because they contain real
  organization/account/session data. The temporary rows were removed, so the
  final UI state is the durable cleanup evidence.
- The whole-process resource samples are recorded in
  `docs/org2-performance-guard-2026-07-30/PR610OrgChannels.md`; they are not a
  feature-isolated benchmark.

## Automated evidence

- Focused current-code run:
  `pnpm exec vitest run src/store/chatPanel/__tests__/chatPanelChannelTabs.test.ts src/features/Org2Cloud/channels/useOrgChannels.test.ts src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/channelsSection.orgSwitch.test.ts`
  — 3 files, 21 tests passed.
- Dual executable build:
  `pnpm run tauri:build:fast:dual` — both identities built successfully in
  198.9 seconds for the functional run. After merging the latest `develop`, the
  same command returned exit code 0 in 49.0 seconds from the completed
  incremental artifacts.
- Final post-integration smoke: both newly timestamped executables launched
  simultaneously, retained separate process identities/settings/ports, opened
  the same organization with no temporary channels present, and closed cleanly.
- Final post-integration suite: `pnpm exec vitest run --reporter=dot` returned
  exit code 0 in 255.8 seconds; typecheck, changed-file ESLint, circular
  dependency scan, cloud i18n completeness, and `git diff --check` also passed.
