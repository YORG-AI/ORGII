# Dual-Instance Storm Cell — receiver cap under a real teammate stream

Date: 2026-08-07. Protocol: `.orgii/skills/dual-instance-verification`.
Purpose: verify P0 finding #1 (peer `ORG_CONTROL_CHANGED {sessions}` bypassing
the coalescer). This path is **unobservable on one machine** — Supabase
broadcasts are `self:false`, so only a second account's pushes exercise it.

## Setup

|         | Instance 1 (receiver, under test)                                            | Instance 2 (sender)                                                          |
| ------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Build   | worktree `fix/realtime-sessions-signal-coalesce` @ 0829a9b (all fix batches) | pre-existing bundle (unpatched — correct: the sender side is unchanged)      |
| Account | vinceorz                                                                     | vinceorz418                                                                  |
| Org     | CU New Target 0720 (`34e24e9e-…`) — both members                             | same                                                                         |
| Session | —                                                                            | `osagent-9d524bca-…` "PR743 接收端限流风暴测试验证", org-tagged, full_replay |

Storm driver: a real Deepseek V4 Pro round streaming a ten-section answer
(~28s agent work, 2 rounds), i.e. continuous `cloud_append_session_events`
pushes from instance 2 → server `sessions` signal (1s per-kind debounce) +
peer `ORG_CONTROL_CHANGED {sessions}` broadcast (250ms sender collapse).

## Result — PASS

Instance-1 cmd+5, "last 2 minutes" hotspot panel, sampled through the storm:

| Sample (clock)        | `cloud_list_org_sessions`    | note                                                             |
| --------------------- | ---------------------------- | ---------------------------------------------------------------- |
| 10:52:32 (mid-storm)  | **1.5/min — 3 calls / 2min** | while `cloud_append_session_events` from the peer ran at 8.0/min |
| 10:54:14 (mid-storm)  | **1.5/min — 3 calls / 2min** | peer appends 9.0/min                                             |
| 10:54:38 (storm tail) | not in top-3 hotspots        | peer appends 6.5/min                                             |

Pre-fix expectation for this exact scenario: one immediate listing per peer
push (250ms-collapsed) ⇒ 20-40/min. Measured: **1.5/min**, i.e. the receiver
now refreshes on the 15s plane (≤4/min ceiling) regardless of how fast the
teammate streams. The listing rate stayed FLAT while the peer's append rate
varied 6.5→9.0/min — the decoupling the fix was meant to produce.

## Other protocol cells

- **Destructive-effect audit (INFO level, storm window 10:47-10:55)**: 3 hits,
  all `epoch rewrite` on codexapp-rollout sessions in the newly-selected org
  — first-selection re-anchor after the org scope switch (one carried
  `chainMismatch=true`, the legitimate re-anchor trigger). No `retract`,
  `delete`, `demote`, `vanish`, or `superseded`. Zero ERROR, zero watchdog /
  dead-man / retry-exhausted lines.
- **Receiver-depth**: the storm session rendered on instance 1 (sidebar
  "PR743 接收端限流风暴…" bright row, opened, streamed content visible and
  matching the sender's round verbatim).
- **Resource three-piece**: instance 1 settled at 0.0-1.0% CPU / ~214MB RSS
  seven minutes after boot; no CPU wave during the storm.
- **Cleanup**: test session deleted on instance 2; the cloud row is left to
  the ordinary two-strike vanished-sweep (design path, not forced).

## Two-boot determinism cell — PASS (added 11:09-11:15)

Instance 1 cold-booted twice on the same binary with unchanged local state,
each boot audited over its first ~2.5 minutes of passes:

|                       | Boot 1 (11:09:00)                                                                                     | Boot 2 (11:12:16)           |
| --------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------- |
| Epoch rewrites        | **0**                                                                                                 | **0**                       |
| Destructive-verb hits | 1 — "retract reconcile: covering 2 background org(s)" (coverage announcement, no retraction executed) | identical single line       |
| ERROR lines           | 4 (known TeamInbox notification-registration noise, present on every boot of every build today)       | 4 (same)                    |
| Realtime ready        | subscribed 16s after launch                                                                           | subscribed 15s after launch |

Liveness beside the absence: the sweep pass demonstrably ran on both boots
(the coverage line is emitted by it), and the earlier storm window proved the
same binary's push/pull planes active — the zeros are audited quiet, not a
dead engine.

## UNCOVERED (recorded per protocol §6)

- **Cloud ground-truth ledger diff** — needs the Supabase service key, which
  lives only in Vercel env. Not run; the log-level destructive audit above is
  the substitute, which is weaker (it cannot see rows nobody logged about).
- **Fault-injection cell** — not run this round; the change is receiver-side
  coalescing with no new read/probe fault point, so the rotation's targets
  are unchanged from the last run. The backoff-hold contract change is
  covered by the rewritten engine unit test.
- **B→A direction** — instance 2 runs an unpatched bundle by design (it is the
  sender). The reverse direction would test instance 2's receiver code, which
  is not the code under test.
