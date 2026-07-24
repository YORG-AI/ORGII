# Desktop Client Cloud-Usage Audit

Auditor: fable subagent, 2026-07-23. Branch `codex/reclaim-cloud-realtime-connections`, scope `src/features/Org2Cloud/**` + sidebar/panel consumers.

## A. Critical — focus-flip and restart hot paths

### A1. Every blur→focus flip runs a full recovery batch with no short-circuit — ~6+N RPCs, two FULL listings, plus socket churn

- Lease releases on ANY blur (`org2CloudRealtimeLease.ts:81-85`; `windowFocus.ts:7-11` requires `document.hasFocus()`). Release nulls `activeRealtimeOrgId` (`useOrg2CloudRealtime.ts:154-155`) → connection effect dependency → socket + channels torn down on blur, rebuilt on focus.
- On focus, SUBSCRIBED edges fire: Slice A `refetchOrgs()` = `list_my_orgs` + `get_entitlement_state × N` fan-out (`org2CloudOrgsAtom.ts:348-356`); Slice B `invalidateOrgInbound(org, {full:true, pushSessions:true})` → repo-scope refetch (TTL cleared) + FULL `cloud_list_org_collab_state` (cursor bypassed) + full outbound session scan + `refreshEntitlementForOrg` + FULL `cloud_list_org_sessions`; roster bump defeats the members cache when the member filter is mounted.
- Independently the remote-sessions atom's own focus listener fires a SECOND full `cloud_list_org_sessions` (`org2CloudRemoteSessionsAtom.ts:497-514`) that never records into version bookkeeping — the Slice B bump fetches again after it.
- No minimum-disconnect-duration gate anywhere: a 2-second alt-tab pays the identical price as overnight sleep, though delta paths exist (serverCursor + `mergeRemoteSessionDelta` with tombstones; collab-state cursor).
- Fleet impact: ~9 RPCs (2 full listings) + 1 socket + 4 channel joins per flip; 50 flips/day × 10k users ≈ **4.5M RPCs/day + 500k socket connects/day** from alt-tabbing alone.

**Fix:** (1) 30–60s grace on lease release (immediate on hidden/pagehide); (2) disconnect-duration-gated full-vs-delta recovery; (3) skip Slice A refetch < X s after last roster read; (4) route focus-recovery through the same version bookkeeping as Slice B.

### A2. Cold-start metadata hash seed can never match — every restart re-upserts metadata for every pushed session

- `seedFromRemoteSummary` stores the hash of the STRIPPED payload (`org2CloudSessionSync.ts:99-105`), but `upsertMetadataIfChanged` compares the hash of the FULL payload (`:161-162`), which always contains `id` and `ownerMemberId` (`collabSyncUtils.ts:247-250`) that `metadataPayloadForHash` deletes (`org2CloudSessionSync.metadata.ts:37-39`). The hashes NEVER match → the seed never suppresses the first upsert. No test covers it.
- Impact: every restart re-sends byte-identical `cloud_upsert_session_metadata × S` + `broadcastOrgControlChangedToPeers` → peer re-list amplification. 10k users × 2 restarts × 20 sessions = ~400k pointless write RPCs/day.

**Fix:** additionally store the full-payload hash in `seedFromRemoteSummary`. One-line-class, high leverage.

### A3. Visible-but-unfocused window: no realtime, no recovery, indefinitely stale UI

- Lease requires keyboard focus; a second-monitor window holds NO socket; the foreground-recovery path early-returns without focus (`org2CloudRemoteSessionsAtom.ts:504-510`); no polling fallback; the hook still reports `documentVisible: true` so the UI looks live. Multi-monitor "watch the team sidebar" silently stales for hours.

**Fix:** hold the lease while `visibilityState === "visible"` (release only on hidden) — also eliminates most of A1's churn; or add a slow visible-unfocused refresh.

## B. High — fan-out and retry behavior

### B1. `get_entitlement_state × N` fan-out on every roster read; coordinator defers duplicates instead of dropping

- Both roster paths hydrate all orgs (`org2CloudOrgsAtom.ts:282-287`, `:348-356`); gated calls arm a trailing timer that fires a REAL RPC at TTL expiry (`org2CloudEntitlementCoordinator.ts:82-95`) — delayed, not dropped (~1/10s/org sustained). **Fix:** return `orgSharingFloor` inside `list_my_orgs` (one RPC replaces N+1), or hydrate only the active org eagerly.

### B2. Outage recovery has zero jitter anywhere — synchronized herd

- `online`: `clearAllOrgBackoffs` + `forceAllInbound/ProjectsNextPass` + immediate pass (`org2CloudSyncLifecycle.ts:100-108`) → N full collab listings per client at the instant connectivity returns.
- supabase-js rejoins on fixed schedule; every SUBSCRIBED edge fires the A1 batch, no jitter (`useOrg2CloudRealtime.ts:292-297, 373-388`).
- `useOrg2CloudOrgs` fixed [2s,5s,10s,20s]; `fetchWithTransportRetry` re-sends immediately with no delay (`org2CloudFetchRetry.ts:23-28`) — 2× amplifier during hard outage.
- Comments error retry: flat 10s loop, no growth, no cap (`commentTransforms.ts:28,109-120` + re-arm at `org2CloudSessionCommentsAtom.ts:329-337`) — 6 list RPCs/min per open surface while degraded, indefinitely.

**Fix:** 0–5s jitter before SUBSCRIBED-edge recovery and the online pass; exponential backoff + cap for comments; randomized delay in transport retry.

### B3. App start does most expensive reads twice

- `list_my_orgs` ×2 (initial + Slice A SUBSCRIBED), each with ×N entitlement fan-out; `cloud_list_org_sessions` ×2 for the active org (engine cold-start summary + sidebar atom initial fetch); `cloud_get_org_repo_scopes` ×2; collab-state FULL × N at start then again for active org. Realistic start (N=3, S=20): ~40 RPCs, half redundant, plus the A2 upsert storm. **Fix:** share the cold-start summary with the remote-sessions atom; suppress SUBSCRIBED-edge full recovery within X s of engine start.

### B4. `forceAllInbound` recovery scales O(N orgs) with FULL listings

- Start/online/roster-change set `forceAllInboundNextPass` → full `cloud_list_org_collab_state` for ALL orgs (`org2CloudSyncEngine.ts:578-580`), incl. never-opened ones. **Fix:** full for active org only; cursor delta or defer-to-activation for the rest.

## C. Medium

### C1. Missed-event heal map (verified)

Heals: SUBSCRIBED edges (active org), focus recovery, `online`, roster reconcile, explicit refresh/org switch.
Gaps: visible-unfocused (A3); comment surfaces for sessions outside the active realtime org (no signal source; TTL only gates, never schedules); inactive orgs stale-by-design until selected (unbounded now — the removed recurring pass used to bound it); outbound sessions tagged to non-active orgs not pushed until activation (deliberate, no indicator).

### C2. Persisted localStorage maps grow without session-level GC

- Roster reconcile prunes by dead org only (`org2CloudRosterReconcile.ts:97-133`); `org2CloudPushCursorsAtom` / `org2CloudPushedMetadataAtom` keep entries for locally deleted sessions forever; `accessSettings` + `sharingFloor` deliberately excluded from pruning → zombie org entries accumulate across backend resets. **Fix:** endpoint-scoped storage keys + session-level sweep against the local registry.

### C3. In-memory bounds healthy (verified OK)

Remote sessions 64, comments 128, roster cache 64, force tokens 500; engine maps pruned per pass; identity flips clear everything.

## D. Low — payload notes

- Tail re-upload growth: frozen line = first non-terminal event; long streaming turn ⇒ each 3s-debounced append re-uploads the whole tail — O(turn²) bytes per turn (gzipped). Consider capping tail size or gating on tail-delta bytes.
- `EVENTS_CLEAN_TTL_MS` 10-min expiry re-reads + re-hashes all events per candidate session (local cost only).
- Comments listing always full + force-refetched per peer mutation — acceptable at current thread sizes.

## E. Subscription scope — verified O(1) per client

Single connection, 3 postgres-changes + 1 presence channel, active org only; `eventsPerSecond: 5`; presence budget 5/30s. Minor: whole socket rebuilt on org switch (drags a redundant `list_my_orgs` + entitlement fan-out); reusing the socket and swapping channels would remove it.

## Top 5 first

1. A2 hash-seed fix (tiny; kills the restart write storm).
2. A1 lease grace + duration-gated recovery (~4.5M RPCs/day at 10k users).
3. A3 hold lease while visible.
4. B2 jitter + comments backoff.
5. B1/B4 batched entitlements in `list_my_orgs` + active-org-only full listings.
