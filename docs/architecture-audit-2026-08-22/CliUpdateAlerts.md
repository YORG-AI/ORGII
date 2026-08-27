# CLI update alerts architecture audit

## Acceptance criteria

- Disabling alerts prevents automatic, manual, and scheduled CLI version checks.
- Closing an alert suppresses only that CLI for six hours and survives remounts.
- “No alert until next version” suppresses only the advertised latest version.
- Multiple mounted consumers share one expiry timer and one single-flight RPC.

## Ten-layer review

| Layer                      | Verdict          | Evidence                                                                                                                                                         |
| -------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation             | pass             | Full `tsc --noEmit`, focused ESLint, and focused Vitest suite pass.                                                                                              |
| 2. Dead code / duplication | pass             | The former component-local dismissed-key state and per-component timer path were removed; scan caching, single-flight work, and scheduling have one coordinator. |
| 3. Naming                  | pass             | `snooze` consistently means a six-hour deadline; `muteUntilNextVersion` consistently means matching `latest_version`.                                            |
| 4. Semantic overloading    | pass             | `snoozedUntil` is temporal, `mutedLatestVersion` is release-scoped, and `enabled` gates checks as well as presentation. No field carries two meanings.           |
| 5. Default branches        | pass             | No enum catch-all or behavior default was added. The persisted preference has an explicit backward-compatible default of `true`.                                 |
| 6. Cross-domain leakage    | pass             | Generic scan coordination owns cache/timer mechanics; Session Creator owns alert policy; Agent Teams owns the settings row.                                      |
| 7. New-developer clarity   | pass             | Public atom and coordinator names state the user-visible behavior and lifecycle directly.                                                                        |
| 8. Wire protocol           | pass / unchanged | No schema or payload shape changed. Tests assert the existing RPC receives the exact selected CLI and `force: true` only for rechecks.                           |
| 9. Init parity             | pass             | Automatic selection, manual refresh, and snooze expiry all share the same enabled gate and `scanVersion` coordinator.                                            |
| 10. Resolver symmetry      | not applicable   | No multi-field fallback resolver was introduced or changed.                                                                                                      |

## Entry-point matrix

| Entry point               | Alerts on                    | Alerts off         | Force |
| ------------------------- | ---------------------------- | ------------------ | ----- |
| Selected CLI mount/change | Demand-driven scan           | No call            | No    |
| Alert refresh button      | Recheck selected CLI         | Guarded; no call   | Yes   |
| Six-hour snooze expiry    | One shared scheduled recheck | Timer unsubscribed | Yes   |

## Term table

| Term                    | Meaning                                               | Storage / owner                      |
| ----------------------- | ----------------------------------------------------- | ------------------------------------ |
| alert enabled           | Whether version checks and update alerts exist        | Persisted global preference atom     |
| snooze                  | Hide one CLI until a deadline                         | Persisted per-CLI suppression        |
| mute until next version | Hide while `latest_version` equals the stored release | Persisted per-CLI suppression        |
| scheduled recheck       | One-shot forced scan at snooze expiry                 | Shared in-memory version coordinator |
