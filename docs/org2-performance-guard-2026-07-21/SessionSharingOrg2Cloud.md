# ORG2 Performance Guard — PR #482 Session Sharing

Date: 2026-07-21

Scope: all background work and retained state added or changed by PR #482: sync passes,
Realtime/presence, roster/member/session/comment caches, guest validation, projection Worker,
imported-session turn paging, diagnostics, and dual-instance runtime isolation.

## Verdict

**Pass.** The previously observed 2.57 GB settled footprint was not acceptable and was traced to
an imported-session turn-index mismatch that forced full-history fallback. After accepting the
imported `user` alias and paging by turn, the same real session settles near 0.5 GB while open and
releases its current-session/Chat tree allocations when closed. This audit found and fixed the
remaining Worker-transition and per-org/session cache-retention gaps.

## Resource lifecycle matrix

| Resource                                  | Owner / bound                                                  | Visible                                            | Hidden                       | Signed out / identity switch             | Terminal state                                        |
| ----------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------- | ---------------------------- | ---------------------------------------- | ----------------------------------------------------- |
| Sync pass timer                           | `Org2CloudSyncLifecycle`, one recursive timer                  | 60s                                                | 300s                         | stopped; all identity state reset        | `stop()` clears timer/listeners/waiters               |
| Inactive entitlement backoff              | per live org                                                   | active org: 5m + one toast; inactive: 30m log-only | same bounded state           | pruned by live roster; reset on identity | removed org is deleted next pass                      |
| Realtime postgres channels                | active org only                                                | push-driven                                        | retained for correctness     | connection disposed/rebuilt              | unsubscribe removes channel                           |
| Presence retries                          | per presence connection, one pending track and broadcast retry | 1s → 30s capped exponential                        | same                         | disposed/rebuilt                         | `leave()` clears timers and pending payloads          |
| Presence roster atom                      | current identity/org                                           | semantic writes only                               | same                         | cleared before paint                     | overwritten/cleared                                   |
| Member panel fallback                     | one 30s interval                                               | fetches                                            | tick skips fetch             | effect teardown/re-arm                   | clear on unmount/org change                           |
| Guest validation                          | one flight per capability; active 5s/all 60s                   | validates                                          | skips, one refresh on return | abort and identity commit guard          | unmount aborts                                        |
| Roster/member/remote/comment caches       | WeakMap per store plus LRU 64/64/64+64/128; force tokens 500   | bounded                                            | n/a                          | cleared on identity                      | store GC                                              |
| Comment nudge counters                    | atom LRU 256                                                   | bounded                                            | n/a                          | cleared                                  | LRU eviction                                          |
| Sync-engine org maps/sets                 | live roster                                                    | pruned every pass                                  | same                         | reset                                    | removed org deleted next pass                         |
| Session-sync hashes/activity/clean planes | live org + local session set                                   | pruned every pass                                  | same                         | reset                                    | deleted session/removed org deleted next pass         |
| Projection Worker state                   | current heavy session only                                     | Worker for large input                             | current surface only         | session-owned                            | cleared on Worker → main switch and unmount           |
| Imported turn bodies                      | current turn plus configured window                            | lazily loaded                                      | n/a                          | session-owned                            | unloaded on close; old turns loaded on navigation     |
| Present-event registry                    | mounted provider instances                                     | one slot per mounted pane                          | n/a                          | n/a                                      | symmetric unmount; last instance removes session slot |

## Findings and decisions

| Area                                   | Verdict            | Evidence                                                                                                     | Change or reason                                                                                                      |
| -------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Signed-out sync engine                 | fixed              | Timer and maps originally survived auth removal.                                                             | Identity-keyed stop/start and full reset.                                                                             |
| Presence retry loop                    | fixed              | Persistent failures re-armed at 1 Hz.                                                                        | Capped exponential backoff with reset on recovery.                                                                    |
| Presence heartbeat renders             | fixed              | Every sync wrote a fresh roster object.                                                                      | Semantic equality ignores heartbeat-only timestamps.                                                                  |
| Comments signal growth                 | fixed              | One key per historically nudged session.                                                                     | 256-key LRU for every writer.                                                                                         |
| Removed-org state                      | fixed in this pass | Only four backoff maps were pruned.                                                                          | `pruneRemovedOrgState` now covers backoff, hydration, aliases, inbound cursors, pending/full state, and session sync. |
| Deleted-session sync caches            | fixed in this pass | Push hashes, clean planes, and activity stamps lived until identity reset.                                   | `Org2CloudSessionSync.prune` uses the live roster and local session list each pass.                                   |
| Projection Worker transition           | fixed in this pass | Heavy Worker graph survived switching to a small main-thread session.                                        | Clear Worker state/input on every non-Worker input; Worker → main → Worker regression proves a fresh snapshot.        |
| Imported session full-history fallback | fixed              | 7,569-event / 42.9M-character session had zero indexed turns because imports use `user`, not `user_message`. | Turn-index v11 recognizes both aliases; UI loads a bounded turn window and normalizes both preview prefixes.          |
| Per-event hash on dirty push           | keep               | Runs only for event-dirty sessions; clean plane has 10m TTL/activity invalidation.                           | Work is proportional to real edits, not idle time.                                                                    |
| Project push retry while hidden        | keep               | One-shot 30.25s, single-flight.                                                                              | Durable-outbox exception; bounded and required for eventual write delivery.                                           |
| Native context-menu handles            | follow-up sweep    | User-click-driven pattern occurs at 12+ sites.                                                               | Measure Tauri handle retention, then fix centrally if necessary; not an idle session-sharing regression.              |

## Real packaged dual-instance measurements

Measured earlier on this PR branch with two real Tauri render processes and the second account's
isolated session DB, after the turn-index/paging fix and before the final audit-only lifecycle
follow-ups. The stress fixture is `imported-session-1a3b30ee6dcea9cd52580821f805e432`: 7,569 events,
approximately 42.9M characters, 54 user turns, and 250 embedded `data:image` payloads.

| State                                                                           | App working set | WebView helpers |                         Backend | Other evidence                                       |
| ------------------------------------------------------------------------------- | --------------: | --------------: | ------------------------------: | ---------------------------------------------------- |
| Before turn-index fix, full replay peak                                         |         4.50 GB |   4.176 GB peak |                        included | unacceptable                                         |
| Before fix, settled                                                             |         2.66 GB |        2.447 GB |                        included | unacceptable                                         |
| After fix, latest turn                                                          |        467.3 MB |          414 MB |                           54 MB | 122 FPS                                              |
| After fix, worst sampled historical turn (803 events, 11.58M chars, 102 images) |        512.0 MB |          436 MB |                           76 MB | 2,195 DOM nodes, 122 FPS                             |
| Return to latest                                                                |        515.7 MB |             n/a |                             n/a | stable, no replay spike                              |
| Session closed                                                                  |        459.9 MB |          384 MB | current-session allocation 0 MB | Chat rendered tree removed, 1,731 DOM nodes, 122 FPS |

At the worst sampled historical turn the diagnostics attributed about 45 MB to runtime
estimates, 19 MB to snapshots, 14 MB to current-session state, and 53/12 MB to the Chat rendered
tree buckets. Closing the session removed the current-session and Chat-tree ownership as
expected. A true idle CPU percentage was not captured; this report therefore does not claim an
idle-CPU number. Code-level timer cadence/backoff and the stable 122 FPS surface provide
supporting, not substitutive, evidence.

## Correctness and privacy invariants

- Presence equality suppresses only semantically identical rosters; user, name, or viewed-session
  changes still publish.
- Revocation eviction, server authorization, comment visibility, and directed-share boundaries
  are unchanged by cache pruning.
- Pruning uses only authoritative live roster and local session ownership. Persistent remote
  cursors/markers remain governed by reconciliation/retraction rather than transient UI state.
- Turn paging changes local materialization only; imported history remains immutable and forking
  creates an ordinary local continuation.

## Verification

- Targeted performance/lifecycle regressions: 4 files / 83 tests pass.
- Wider Org2Cloud + TeamCollaboration + ChatPanel sweep: 153 files / 1,496 tests pass.
- Full repository run: 592 files / 5,727 tests pass; full ESLint and
  `cargo clippy --workspace` pass (baseline advisory warnings only).
- `tsc --noEmit`, `cargo check`, changed-file lint/format, E2E syntax, frozen lockfile, and
  `git diff --check`: pass.
- Session-persistence imported-user turn-index test: pass.
- Packaged dual-instance memory test: pass at the measurements above.
- Final-head dual build: both executables compile and copy with matching hashes. Final-head UI
  launch was blocked before process creation by Windows Smart App Control's enterprise signing
  requirement (Code Integrity 3077); no bypass was attempted and no final-head UI result is
  claimed.
- Automated cloud dual E2E was not rerun in this shell because no `E2E_CLOUD_*` service/password
  credentials are present. This is a test-environment limitation, not a silent pass.
