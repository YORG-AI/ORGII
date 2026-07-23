# Issue #443 rendered E2E evidence

Scope: the real 335 MiB Codex “Issue 272” session, external replay open/switch/close lifecycle, native memory attribution, and the requested dual-instance sharing/presence smoke.

## Evidence matrix

| Surface                           | Result  | Production-path evidence                                                                                                                         | Result details                                                                                                                                                  |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Real Codex first open             | PASS    | The rendered Tauri app resolves the imported Codex session through the production bounded-replay adapter and opens the chat session.             | 26 events were hydrated; first-open Physical Footprint growth was 266.4 MiB against the 400 MiB limit.                                                          |
| Ten open/release cycles           | PASS    | Each cycle opens the same real external session, switches back to New Session, releases the replay owner, and measures the app process tree.     | Measured-tail step growth was 0 MiB and backend step growth was 0 MiB.                                                                                          |
| Idle release / #446 compatibility | PASS    | After the final explicit release, the app remains idle while native process memory is sampled every five seconds for a bounded 30-second window. | The allocator high-water mark fell to 47.1 MiB over baseline without lowering the 250 MiB threshold.                                                            |
| #435 native attribution           | PASS    | Every process row returned by `get_app_memory_snapshot_v1` is compared with `/usr/bin/vmmap -summary`.                                           | Native total 691.9 MiB versus vmmap 702.8 MiB; 10.9 MiB difference is within `max(10%, 50 MiB)`.                                                                |
| Hard event bound                  | PASS    | The open-session result returns only compact identity and event count; it does not serialize the full event store back through WebDriver.        | Every cycle returned 26 events, below the 200-event hard cap.                                                                                                   |
| Dual-instance sharing/presence    | BLOCKED | `cloud-dual-instance-ui.spec.mjs` loads and reaches its live credential gate after repairing the local E2E dependency installation.              | All 12 live scenarios are explicitly skipped because `E2E_CLOUD_SUPABASE_URL`, `E2E_CLOUD_ANON_KEY`, and a service-key or email/password credential are absent. |

## Failure-driven harness correction

The first post-merge run sampled each release after only one second and failed with a renderer-dominated 330.4 MiB “settled” growth even though the backend and measured-tail step growth stayed bounded. The acceptance test now preserves the same 250 MiB limit but adds a bounded 30-second idle sampling window. The next fresh-home run showed WebKit returning pages after ten seconds and settling to 47.1 MiB over baseline by 30 seconds. This distinguishes delayed allocator reclamation from retained live replay state without manufacturing a pass.

## Commands

- `E2E_CHAT_RENDERING_SCENARIOS=issue-443-real-codex pnpm test -- --spec './specs/core/chat-rendering-ui.spec.mjs'`: PASS, one real rendered scenario.
- `pnpm test -- --spec './specs/core/cloud-dual-instance-ui.spec.mjs'`: infrastructure gate reached; 12 live scenarios BLOCKED/SKIPPED for missing cloud credentials.

The large real JSONL and isolated ORGII homes remain outside Git.
