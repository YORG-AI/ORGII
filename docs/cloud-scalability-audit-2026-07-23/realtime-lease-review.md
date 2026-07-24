# Adversarial Review: Foreground-Lease Realtime Reclaim (fd41d508c)

Auditor: fable subagent, 2026-07-23. Traced against `@supabase/realtime-js@2.106.2` sources and the pre-commit code via `git show`.

## Cost of one lease flip (CONFIRMED baseline)

`isWindowFocused()` = `document.hasFocus() && !document.hidden`; the lease has zero hysteresis by design. Every blur tears down the socket + 4 channels; every refocus rebuilds and fires: 4 channel joins (each postgres_changes join inserts a `realtime.subscription` row with RLS evaluation; private presence join runs the `realtime.messages` RLS check), `list_my_orgs`, full inbound invalidation (repo scopes + FULL collab listing + push pass + entitlement + FULL session listing), members RPC if panel open, presence rejoin, plus the remote-sessions atom's own second full listing and guest-share `validate("all")`. Net ~5–8 RPCs incl. 2–3 full listings per flip, no debounce anywhere.

## Findings (severity-ordered)

1. **HIGH — No hysteresis: blur-triggered release makes routine desktop interactions pay the full teardown/recovery burst (CONFIRMED).** Cmd-tab, second-monitor clicks, Spotlight, native dialogs all flip `document.hasFocus()`. 100–300 flips/day ⇒ ~400–1200 channel joins + ~500–2400 RPCs/day per client. Fetches launched by an edge are not cancelled on the next release. Fix: 30–60s grace on release only (immediate on hidden→pagehide/sign-out), cancel on refocus.

2. **HIGH — "A hidden window keeps pushing" is false in code (CONFIRMED).** The commit removed the recurring pass; what remains is visibility-gated: `scheduleActivityPass` early-returns when hidden (`org2CloudSyncLifecycle.ts:289`); projects outbox latches but skips dispatch when hidden (`:310-321`); `invalidateOrgInbound`/`reconcileRoster` skip too (`:240, 284`). Minimized for an hour ⇒ teammates see no replay progress and no work-item changes; agent comment replies still post over HTTP (`addressCommentsRun.ts:185-195`) so replies can reference transcript content teammates cannot see. Pre-commit hidden convergence was bounded at 5 min; now unbounded. Fix: trigger one pass on agent turn-terminal and outbox-write even when hidden (concrete events, no polling). Verified NOT broken: no runner waits on a realtime signal (turn lifecycle is a local atom; work-item locks are boundary RPCs) — nothing deadlocks while hidden.

3. **MED-HIGH — Presence viewer-chips regression (CONFIRMED).** Pre-commit code carried the explicit lesson that clearing presence on blur made every viewer chip vanish; the lease reintroduces exactly that via Slice C cleanup → `handle.leave()` on every blur (`useOrg2CloudRealtime.ts:589-606`, `org2CloudRealtimeClient.ts:505-521`). The grace period fixes this too.

4. **MED — Comments missed during a short blur can be swallowed by the 30s TTL (CONFIRMED path).** SUBSCRIBED-edge comment recovery is the org-wide bump, deliberately non-forced; `decideSessionCommentsFetch` skips within `SESSION_COMMENTS_TTL_MS = 30_000`. Blur at T+5s, teammate comments at T+10s, refocus at T+20s → bump inside TTL → skip; TTL expiry alone schedules nothing → comment invisible until an unrelated future event. Fix: force-token the recovery bump or make it TTL-exempt.

5. **MED — Reconnect thundering herd: no jitter anywhere (mechanics CONFIRMED).** realtime-js reconnects at [1s,2s,5s,10s] then flat 10s, no jitter, and no `reconnectAfterMs` override is passed; every transient CHANNEL_ERROR/TIMED_OUT rejoin fires the full burst (no cooldown on the true-edge); `fetchWithTransportRetry` doubles failed POSTs immediately; laptop wake `onOnline` forces full listings across every org at once. Fix: jittered `reconnectAfterMs`, 0–3s random delay before edge recovery, per-org cooldown on repeated full recoveries (<30s).

6. **MED — Non-active orgs: recovery never fires for them; staleness now unbounded (CONFIRMED gap).** Slice B subscribes only the active org; other orgs recover only on online/roster-change/restart/activation. The removed pass used to bound this at 60s/5min. Tombstone-free absences require the full listing, so a revoked project in org B is simply wrong locally all day. State the contract or add a cursor-preserving invalidation for other orgs on refocus.

7. **LOW — Double full `cloud_list_org_sessions` per refocus (CONFIRMED).** Focus-listener fetch starts; SUBSCRIBED-edge full bump lands mid-flight, is not recorded (in-flight early-return precedes version recording), completion wakes the effect via `entrySnapshot` → second full listing. Fix: record a full bump as satisfied when a full fetch is already in flight, or drop the hook's own focus listener.

8. **LOW — No true zombie connections (CONFIRMED).** `dispose()` reached on all paths; disposed-client guard + channel-name sequence suffix prevent topic reuse races. Residual warts: disposing a still-CONNECTING socket is now a steady-state noise source (was boot-only); the pagehide `releaseImmediately` path is effectively cosmetic (OS socket close does the real work).

9. **Lease correctness & billing (CONFIRMED with caveats).** State machine sound; initialHeld render/effect reconciliation correct; single `main` window so multi-window is a non-issue. Billing verified: Realtime bills the highest concurrent-connection count per cycle ($10/1,000 over quota; Pro includes 500) plus messages ($2.50/M over 5M). Releasing while hidden lowers the billed peak by the fraction of running-but-unfocused clients at the fleet's busiest instant — large for a 24/7-resident desktop fleet, so the win is real. But flapping monetizes the messages meter (~200 flips × ~10 messages/day/client) and lands un-metered Postgres RPC + subscription-RLS load. At 1,000 clients × 200 flips: ~800k channel joins + ~1–2M recovery RPCs/day vs a held connection's ~4 joins/day. The grace period keeps the billing win and deletes most of the load.

## Verdict

**Sound in architecture, not yet sound to ship as-is.** Ship-blockers: release-on-blur with zero grace (finding 1, plus the presence regression 3), and the hidden-push freeze contradicting the design's own contract (2).

Three highest-leverage improvements:

1. Release-side grace period (30–60s) in the lease controller.
2. Event-driven hidden push (turn-terminal + outbox-write trigger one pass while hidden).
3. Harden the recovery edge: force-token comments recovery, dedupe the double listing, jittered reconnect + per-org full-recovery cooldown.
