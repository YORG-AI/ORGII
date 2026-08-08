# Call-Hotspot Audit — Session Sharing + Runtime (2026-08-07)

Standard (established in the `cloud_list_org_sessions` 38/min investigation, PR #743):

1. **No polling** — no `setInterval`, no self-rearming timer without a concrete event source.
2. **Storm-coalesced** — every signal→fetch path bounded; the server debounces broadcasts at 1s per (org, kind), so any client window ≤1s gives zero sustained protection.
3. **Idle-silent** — zero calls with no signals; zero while hidden.
4. **Echo-aware** — own writes must not trigger own refetches.
5. **Focus/lease-bounded** — per-focus-regain cost bounded and cooled down.
6. **Bounded retry** — every failure path capped; backoff not defeatable.

Scope: five domains, one report each (see files in this folder). Method: five parallel
read-only audit agents, load-bearing claims re-verified by hand (marked ✅ below).

## Verdict counts

- **VIOLATION (fix): 6** — 3 hand-verified core, 3 agent-verified storm-class
- **WATCH (tighten when convenient): 12**
- **OK / keep-with-reason: everything else** (sharing surfaces and the member-runtime
  push scheduler are exemplary; sharing has zero polling and fully capped pagination)

## Fix batch P0 — defeats or multiplies past today's fix

| #   | Finding                                                                                                                                                                                                                                                                                                                             | Where                                                           | Cost today                                                                                                  | Fix                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | ✅ Peer `ORG_CONTROL_CHANGED {kind:"sessions"}` bumps the listing **immediately**, bypassing the 15s sessions plane. Sent after EVERY successful peer push (5 sites: org2CloudSessionSync.ts:329,361,1019,1116,1447; sender collapse only 250ms). Broadcast is peers-only (`self:false`), so single-machine testing never shows it. | useOrg2CloudRealtime.ts:856-857                                 | One streaming teammate ⇒ every receiver re-lists ~20-40/min — the surviving half of the original 38/min bug | Route through `scheduleSessionsPlaneRefresh`                                                                |
| 2   | ✅ `member_runtime` signal kind is not in `parseOrgDbChangeKind` → unknown-kind fallback = **full coarse refresh** (inbound pass + listing + comments + channels + channelMessages + control-plane). Zero consumers of the actual data signal; Team Runtime panel stays stale until remount.                                        | org2CloudControlBus.ts:80-104 → useOrg2CloudRealtime.ts:833-841 | N teammates × (60/interval)/hr full multi-plane refreshes per client; pure cost, zero benefit               | Recognize the kind; map to a narrow member-runtime version bump (and let `useTeamRuntimeRoster` consume it) |
| 3   | ✅ `invalidateOrgInbound` clears the org quota/disabled backoff on **every** realtime nudge, contradicting the tracker's own contract ("silent until a meaningful external/user signal").                                                                                                                                           | org2CloudSyncLifecycle.ts:251                                   | A QUOTA_EXCEEDED/SYNC_DISABLED org retries every ~3-15s during team activity instead of 5/30min             | Clear backoff only on policy signals, explicit user action, and full edge recovery                          |

## Fix batch P1 — storm-class, conditions rarer

| #   | Finding                                                                                                                                                                                                                                                                                                                                                                                   | Where                                                                                                                                         | Cost                                                           | Fix                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 4   | Team Inbox re-lists in full (local sqlite + `cloud_list_team_inbox_mentions`) on every comments-plane bump; hook always mounted via sidebar connector; no delta mode, no TTL                                                                                                                                                                                                              | useTeamInboxDataSource.ts:377-388                                                                                                             | Comment storm ⇒ up to 60 dual-source listings/min              | TTL floor or a wider comments→inbox window (15s-class)                     |
| 5   | Remaining 750ms plane windows are structurally below the server's 1s per-kind debounce: channels (full re-list per bump), inbound (multi-RPC sync pass per bump), comments org key, channelMessages (delta — least bad)                                                                                                                                                                   | useOrg2CloudRealtime.ts:553-586                                                                                                               | Up to 60 fetches/min per plane under a per-kind storm          | Widen per-plane windows (5-15s); channels full-list and inbound pass first |
| 6   | Focus-flap refetches have no cooldown, unlike the realtime edge's 30s policy (org2CloudRealtimeRecovery.ts:17): remote-sessions raw focus/visibility listeners (FULL paged listing per flap), useOrgChannels focus refetch + per-bump `forceFresh` evicting the in-flight single-flight entry, rosterConvergence `refetchOrgs` per focus event, useTeamRuntimeRoster visible-edge refetch | org2CloudRemoteSessionsAtom.ts:494-527; useOrgChannels.ts:66-86,221-224; org2CloudRosterConvergence.ts:65-67; useTeamRuntimeRoster.ts:219-228 | 10 alt-tabs/5min ⇒ 10× full listings on several planes at once | Shared 30s cooldown helper, mirroring `decideSubscribedEdgeRecovery`       |

## Fix batch P2 — paper cuts

7. Legacy (pre-0005) coarse path re-lists sessions at 60/min under storm — dormant on the managed 0006 backend; matters only for custom endpoints (useOrg2CloudRealtime.ts:682-698). Widen coarse window or accept (keep-with-reason: legacy).
8. Comments error retry (10s→5min) keeps firing while hidden (org2CloudSessionCommentsAtom.ts:361-376).
9. BuilderProfilePanel 1.2s extraction drain not hidden-gated (BuilderProfilePanel.tsx:237-260).
10. Multi-org members pay M× `system_runtime_snapshot` (~1s CPU each) + M× 35-day `usage_dashboard_daily_rollup` per catch-up pass; only the agents probe is pass-shared (memberRuntimePushScheduler.ts:574-587). Share per pass.
11. `runCoarseSignalRefresh` marks planes handled before its hidden check — same bug-shape fbc6cd8d3 fixed for edge recovery; blast radius ≤ one window (useOrg2CloudRealtime.ts:467-478).
12. Trailing-only debounces (3s/30s/1.5s) have no max-wait: continuous sub-window activity **starves pushes** (liveness, not cost) (org2CloudSyncLifecycle.ts:320,339). Add max-wait flush if peer freshness matters.
13. `orgii-data-changed` carries no orgId → every projects pass fans `listOrgCollabState` across all orgs (org2CloudSyncLifecycle.ts:133-135).
14. Share-eligibility `primeShareableScopeKey` kicks a git-remotes IPC from the render path; failure uncached → retried per external re-render while git backend down (useCloudSessionShareDialog.ts:42-44).
15. Stale docs: "60s pass" references (org2CloudSyncEngine.ts:538-540, constants.ts:33-34); `freshToken.ts:18` points at absent `buildDefaultCommentTaskRunnerDeps`.

## Keep-with-reason (audited, deliberate)

- **rosterConvergence 5-min visible-only timer** — the one true recurring poll; documented
  convergence net for inactive-org policy changes. Hidden = timer cleared. Keep, but its
  per-focus refetch is finding #6.
- **Coarse safety net** — one-shot 5min trailing per signal window; not self-rearming.
- **Open-thread per-broadcast comment refresh** — deliberate liveness; force-tokens collapse
  a burst to ≤2 RPCs (agent-1's "N per round" was reconciled against the deeper force-token
  read: bounded per burst, back-to-back only under sustained storms).
- **METADATA_ONLY metadata upsert per pass** — hash-gated no-RPC when unchanged.
- **MemberRuntimePushScheduler** — exemplary: single exact-deadline timer, hidden-silent,
  dueness before any RPC/IPC, all backoffs capped, DISABLED halts retries.
- **Sharing surfaces** — zero polling; pagination capped (64×4096 events, 200×50 listings);
  event-driven waits (jotai signal + single deadline timer); presence never fetches.
- **Sync engine** — verified: no recurring pass exists; idle+hidden = 0 RPCs, 0 armed timers.

## Cross-checks performed

- Sessions-plane echo loop (fixed in PR #743) confirmed closed: version-map pre-record +
  in-flight keys + `entrySnapshot` termination proof (listing-atoms report).
- Supabase broadcast `self:false` verified — the peer control bus does NOT self-echo;
  it is exclusively a teammate-streaming cost.
- cmd+5 IPC burst at launch (detect_local_model_hardware / system_runtime_snapshot /
  usage_dashboard_daily_rollup "Pending") attributed to the telemetry catch-up pass
  (30-120s jitter after start) queueing behind the 1-permit usage semaphore — not a loop.
