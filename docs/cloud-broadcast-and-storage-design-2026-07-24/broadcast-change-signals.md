# Change Signals via Broadcast-from-Database (audit item H4)

Date: 2026-07-24. Basis: realtime signal-chain architecture map (agent survey
of 0001/0003 server path + full client subscription topology). Companion:
`replay-storage-offload.md`.

## Why

`postgres_changes` evaluates RLS per change × per subscriber on a single
shared WAL poller — the platform's first scalability wall (server-schema-audit
H4). The client consumes **zero row data** from any of its three
postgres_changes subscriptions (all onChange callbacks are 0-arg edges), so
the entire contract is "something in scope changed" — a perfect fit for
fire-and-forget broadcast with join-time authorization.

## Decision summary

| Question                                          | Decision                                                                                                                                                      | Why                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | -------- | --------- | ------ | -------------------------------------------------------------------------------------------- |
| Topic                                             | **Reuse the existing private org channel `presence:org:<org_id>`**                                                                                            | Already open on every active client, already authorized by the `realtime.messages` policies (0001:5694-5706), already carries client-side broadcast events (`org-control-changed` etc.). Server-side `realtime.send` from a definer trigger needs no new policy. Channels per client drop 4 → 2. |
| New event                                         | `org-db-changed` with payload `{kind}`                                                                                                                        | Distinct from client-sent `org-control-changed`. `kind` ∈ `sessions                                                                                                                                                                                                                              | comments | projects | workItems | roster | policy`derived from`TG_TABLE_NAME` / call site — the discriminator today's signal row lacks. |
| Debounce                                          | Broadcast fires **only when the debounced signal-row bump actually fired** (the 0003 250ms `WHERE` clause) — per (org, kind)? No: per org, same as today      | Identical delivery semantics to the postgres_changes transport; the client's 60s coarse throttle and 5min control TTL stay unchanged.                                                                                                                                                            |
| Slice A (self-roster eviction)                    | **Stays postgres_changes** on `org_memberships` `user_id=eq.<uid>`                                                                                            | A member removed while disconnected can never be reached by join-time-auth broadcast (`is_org_member()` already false). Exactly the audit's recommendation.                                                                                                                                      |
| Slice B (org signal) + B-roster (org memberships) | Replaced by broadcast events on the org channel when the backend supports it                                                                                  | The two org-scoped postgres_changes channels disappear; SUBSCRIBED-edge recovery bookkeeping moves to the org channel's join edge.                                                                                                                                                               |
| Old signal row / publication                      | **Kept and still bumped** (org_change_signals stays in the publication)                                                                                       | Old clients keep working; removal is a later cleanup migration once the fleet has upgraded.                                                                                                                                                                                                      |
| Capability detection                              | New RPC `get_cloud_capabilities()` → `{broadcastSignals: true}`; client probes once per endpoint, PGRST202 ⇒ legacy                                           | Same probe-and-remember pattern as the 0004 paged listings.                                                                                                                                                                                                                                      |
| Roster nudges for members                         | New AFTER trigger on `org_memberships` → send `kind:'roster'` to the org topic                                                                                | Replaces the org-filtered memberships channel for present members; the removed user is covered by Slice A.                                                                                                                                                                                       |
| Policy nudges                                     | The 3 RPCs with direct in-RPC bumps (`cloud_rename_org`, `cloud_set_org_sharing_floor`, `cloud_set_member_sharing_floor`) recreated with `kind:'policy'` send | They bypass the trigger today; same bypass, now with a broadcast.                                                                                                                                                                                                                                |

## Server (cloud-infra 0005)

1. Helper `org2_cloud.nudge_org_signal(p_org_id uuid, p_kind text)`:
   debounced signal-row upsert (unchanged 250ms suppress) and, **iff the
   bump fired**, `realtime.send(jsonb_build_object('kind', p_kind),
'org-db-changed', 'presence:org:' || p_org_id, true)`.
2. `touch_org_change_signal()` trigger fn delegates to the helper with kind
   mapped from `TG_TABLE_NAME` (`cloud_projects`→projects,
   `cloud_work_items`→workItems, `cloud_sessions`→sessions,
   `cloud_session_comments`→comments).
3. New `AFTER INSERT OR UPDATE OR DELETE` trigger on `org_memberships` →
   `nudge_org_signal(org_id, 'roster')`.
4. Recreate the 3 policy RPCs replacing their inline bump with the helper
   (`kind:'policy'`).
5. `get_cloud_capabilities()` → `jsonb_build_object('broadcastSignals',
true)`, grant `authenticated`.
6. Lock-order invariant preserved: the helper is still the statement-final
   signal-row acquisition (canonical slot 6); `realtime.send` inserts into
   `realtime.messages` (a partitioned insert, no user-table locks) after it.
7. Verify tail: single-signature checks; trigger presence; capabilities
   callable.

Offline validation: brew-PG harness stubs `realtime.send` (records rows into
a scratch table) — assert one broadcast per debounce window per kind source,
none when suppressed, roster/policy events fire, legacy signal row byte-same.

## Client (ORGII)

1. `org2CloudClient` (or syncClient): `getCloudCapabilities(accessToken)`
   with PGRST202→null; per-endpoint memory (`capabilitiesByEndpoint`).
2. `org2CloudRealtimeClient.joinPresence`: surface server broadcasts —
   `org-db-changed` events dispatch to a new `onOrgDbChanged(kind)` option
   next to the existing broadcast handlers; expose the channel's SUBSCRIBED
   edge (already surfaced for presence re-track) to the caller for recovery
   bookkeeping.
3. `useOrg2CloudRealtime`: when capabilities report `broadcastSignals`,
   skip creating Slice B and B-roster postgres_changes channels; wire
   `onOrgDbChanged`: `roster` → `bumpRosterVersion(orgId)` (+ the
   rosterRealtimeConnected atom keyed to the org channel's join edge);
   every other kind → `scheduleCoarseSignalRefresh()` (behavior-identical
   coarse path; per-kind narrowing is a later optimization, the payload
   already carries it). SUBSCRIBED-edge full/delta recovery
   (`decideSubscribedEdgeRecovery`) moves onto the org channel's join edge.
   Slice A unchanged.
4. Legacy backends (probe fails): topology unchanged (3 pg channels + 1
   presence). Tests: transport tests reworked in
   `org2CloudRealtimeClient.test.ts`; recovery/lease/scope tests untouched.

## Quota effect

Broadcast messages still bill per delivery, but: no per-change × per-client
RLS evaluation, no WAL-poller serialization, and the `kind` discriminator
unlocks future per-plane refetch narrowing (today every signal shotguns all
planes after the 60s throttle). The 250ms server debounce and 60s client
throttle keep message volume identical to today's.

## Rollout order

0005 applies live (additive, old clients unaffected) → client PR merges →
fleet upgrades → later cleanup migration drops org_change_signals from the
publication (and eventually the table, once fleet-wide).
