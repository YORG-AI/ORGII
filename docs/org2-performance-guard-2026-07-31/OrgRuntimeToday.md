# ORG2 Performance Guard — Organization-aware Runtime

| Area                 | Verdict | Evidence                                                                                                                                                                                     | Change or reason kept                                                                                                                                                                                                                                        | Verification                                                                                                                                                                                    |
| -------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Background work      | fix     | Organization content is lazy and selected-scope-only. The remote-session hook owns focus/visibility listeners, so retaining it on Member breakdown would be unnecessary.                     | The roster remains the single organization data owner. A resource-owning Today boundary mounts `useCloudOrgRemoteSessions` only for a ready Today view and unmounts it on Members/Personal; the agent-catalog scan runs only for a non-empty Members roster. | Component tests prove Members never invokes the remote-session hook and empty Today never starts the local catalog scan. Source lifecycle sweep confirms no new poll/worker/subscription owner. |
| Memory               | fix     | The shared session listing is already bounded to 64 org entries and server-bounded rows; identity changes clear snapshots. A naive recent-five projection would copy and sort the full list. | `recentSharedSessions` retains at most five rows (`O(n × 5)` time, `O(5)` projection memory), reusing the existing identity/org cache. Switching to Personal unmounts organization consumers.                                                                | Unit tests cover cap, person scope, ordering, and tombstone exclusion. No new app-lifetime collection or persistence key exists.                                                                |
| Scope / isolation    | keep    | Runtime scope uses namespaced selector values; roster completions are generation guarded; remote sessions are endpoint/auth-identity/org keyed and clear on identity switch.                 | Runtime passes a controlled org id to the roster. Invalid/signed-out cloud scope renders as Personal; org changes clear person/detail state.                                                                                                                 | Shell tests cover Personal-to-org tab/prop routing; component tests cover a controlled second org and absence of the nested picker.                                                             |
| Rendering / hot path | fix     | Today folds only the roster's inline eight-day usage window. Scope reset originally used a synchronous effect-driven state write.                                                            | The extra reset render was removed: an effective scope is derived during render. Today projections are memoized; member cards keep stable callbacks and a minute-quantized clock.                                                                            | ESLint's React performance rules pass. Unit tests cover UTC boundaries, active members, stale-sample exclusion, finite CPU/RAM averages, and person selection.                                  |

## Lifecycle matrix

| Dimension | Verified behavior                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| App       | Runtime panels remain lazy; organization code mounts only for a selected cloud scope.                                               |
| Document  | No polling was added. Existing owners revalidate on foreground/visible return and skip hidden reads.                                |
| Network   | Existing bounded timeout, retry, single-flight, generation guard, and last-good-snapshot behavior remains authoritative.            |
| Identity  | Sign-out/account/endpoint changes cannot expose prior rows; invalid cloud selection derives to Personal.                            |
| Scope     | Picking Personal unmounts org consumers; changing org clears person/detail state and remounts with the new controlled id.           |
| Tab       | Today owns the shared-session consumer; Member breakdown owns member cards/catalog/drill-down and retains no session consumer.      |
| Session   | Today renders at most five recent rows; tombstoned rows are excluded; detail requests are user-driven.                              |
| Instance  | No data home, port, cookie, auth, or module-global identity mechanism changed. Existing Tauri instance isolation remains unchanged. |

Privacy/correctness: no wire shape changed. Member telemetry still excludes
session titles/repos/models; the recent list displays only Team Sessions rows
already authorized by the server and explicitly shared by their owner.
Metadata-only rows reveal in Team Sessions without forcing replay.

**Performance verdict: blocked for measured runtime sign-off** — code-level
lifecycle, bounds, isolation, typecheck, lint, and focused tests pass. Live
Tauri visible/hidden idle CPU, working-set, and repeated open/close measurements
were not run because this workspace explicitly forbids Computer Use without
user opt-in. No runtime performance number is inferred from code shape.
