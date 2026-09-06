# Custom API model catalog lifecycle review

**Verdict: native performance verification blocked/unmeasured.** Automated
correctness and structural lifecycle evidence do not establish a CPU/RSS pass.

| Surface               | Active / hidden / idle / disposal behavior                                                                                                                            | Evidence                                                                                              |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Model alias registry  | Replaces its snapshot on existing key mutations; key-scoped maps are cleared each replacement and retain only current credential labels. No new timer or subscription | Registry tests cover scoped collisions and eviction after replacement                                 |
| Wizard validation     | One latest-data ref per mounted wizard; an existing request's result merges current model edits. Changed endpoint/credential input rejects stale catalog writes       | Production hook regression re-renders while validation is pending and applies the captured completion |
| Model row editing     | Existing component state; draft markers leave with the row. No automatic model probe is passed for Custom API, so typing/blur adds no requests                        | Row add/rename/remove test and ApiSetup source wiring                                                 |
| Native catalog writes | Existing KeyService lock/write path, no scan, poll, retry or watcher added. Alias validation precedes mutation; discovery unions explicit IDs in the same write       | Save/reload/refresh/atomic rejection tests                                                            |
| Provider requests     | Constant provider-name branch before existing request construction; no per-token work, storage reads or new global client cache                                       | Twelve loopback requests across two protocols, three ID shapes and stream/non-stream modes            |

The normal, error, empty and save-pending UI states have static component
previews. Native open/close cycles, hidden/background CPU, RSS stabilization and
Windows behavior remain unmeasured. Existing application subscriptions and HTTP
client timeouts were not expanded. No native GUI control was used.
