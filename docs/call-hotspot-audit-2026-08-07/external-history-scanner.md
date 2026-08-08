# External CLI History Scanner / Import Plane (audit wave 2)

Scope: the subsystem watching ~/.claude, codex and other CLI transcript sources,
importing them as sessions and feeding cloud sync.

## Headline: clean by design

The plane is deliberately timer-polled (NO fs watcher) — which is exactly what
makes a 1-write/second live CLI turn cost ZERO scanner work between ticks.
Default cadence 10min (user-selectable down to 60s), hidden pauses everything
(unless an org's background-upload demand holds the 10min floor), presence
probes 30min, failed-scan retry 30s. The #608 re-hash storm guard is verified
current: append-resume from persisted byte watermark + 4KB boundary FNV
fingerprint — cost is O(appended bytes), never O(file). Discovery reuses
dir-mtime snapshot caches; Rust runs all sources under a concurrency-1
semaphore with superseded-job dedupe; multi-caller rescans join one batch.

## End-to-end live-CLI-turn cadence chain (verified)

Live turn writes every second → nothing fires per write → scanner tick
(10min default) tail-parses only the appended bytes → sessionsAtom roster
reload (the tick's dominant cost) → sync engine diffs updated_at → 30s
trailing debounce (60s max-wait) → pass pushes only after the 30s settle
gate. Net: ONE cloud push per scanner tick, ~30s after it. An open-in-chat
imported session additionally stat-probes at 5s focused / 60s unfocused and
explicitly refuses to reload while the signature keeps moving.

Correction to the original storm attribution: a live claude-code session was
NOT the 38/min storm source (its pushes ride the scanner tick, 1 per 10min
by default) — the sustained sessions-signal source was native in-app agent
session traffic. The receiver-side caps apply to any source, so the fixes
stand unchanged.

## Findings

| #     | area                                                                         | verdict | note                                                                                                                                  |
| ----- | ---------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | useDataSourceAutoScan scheduler                                              | OK      | known-good discipline intact (exact-deadline chain, visibility-aware, unfocused floor)                                                |
| 2     | no fs watcher on CLI stores                                                  | WATCH   | deliberate documented trade; freshness capped at cadence                                                                              |
| 3     | watermark tail-parse (#608 guard)                                            | OK      | verified: (same_signature ∥ grew) + identity + boundary fingerprint                                                                   |
| 4     | per-tick stat of every discovered transcript                                 | WATCH   | linear with history size forever (20k/50k caps); nothing prunes old files from discovery                                              |
| 5     | Rust scan coordinator                                                        | OK      | semaphore 1, shared flights, superseded jobs do zero I/O                                                                              |
| 6     | TS rescan dedupe                                                             | OK      | pending-set + join-active-batch                                                                                                       |
| 7     | claude parser incremental cache                                              | OK      | re-parses only changed (mtime,size,parser,managed) signatures                                                                         |
| 8     | roster reload per changed tick                                               | WATCH   | at the 60s opt-in cadence a live turn = per-minute full roster rebuild + activity pass; CPU spike acknowledged in code, not mitigated |
| 9     | presence probes                                                              | OK      | 30min, concurrency 2, absent stores parked                                                                                            |
| 10    | open-session auto-refresh                                                    | OK      | settle-gated reloads, size-tiered cooldowns, hidden owns no timer                                                                     |
| 11-14 | sync engine handoff (activity debounce, settle gate, telemetry detect floor) | OK      | 30s/60s max-wait; 24h agents-detect floor                                                                                             |

## Worst issues

1. The 60s cadence opt-in turns a live CLI turn into a per-minute reingest
   loop (roster rebuild + cloud pass) — consider a "live session" damping
   (e.g. skip roster reload when only the live session's tail moved).
2. Per-tick stat volume grows with total transcript history forever —
   consider aging out files unchanged for N months from the discovery set.
3. No-watcher is fine as a trade but deserves a doc-level statement in the
   audit standard (justified WATCH, not silent).
