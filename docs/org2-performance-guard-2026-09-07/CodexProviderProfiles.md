# Codex provider profile lifecycle review

| Area               | Verdict | Evidence                                                                                                                        | Change or reason kept                             | Verification                                                       |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| Background work    | keep    | Status uses existing shared single-flight invalidation; no new timer, poller, worker or subprocess in production                | Tests/discovery start only from explicit actions  | Rendered save/test/apply/discovery tests; source call-chain review |
| Memory             | keep    | Existing 4-request registry, 64 receipts with 15-minute TTL, 256 KiB HTTP body, 1,000 model IDs, 64 profiles/app, 1 MiB catalog | Codex uses the same bounded owners                | Native catalog tests and HTTP parser bounds                        |
| Scope/isolation    | keep    | Requests are local to mounted editor generation; cancel/unmount send native cancellation; endpoint/auth edits clear discovery   | Common controller retained rather than duplicated | Rendered cancel/late-completion and receipt revision tests         |
| Rendering/hot path | keep    | Only selected app mounts; discovery is a local finite array and never a streaming hot path                                      | No new global cache/subscription                  | Settings selector and profile-editor tests                         |

Lifecycle matrix: clean load and repeated target selection use the existing status coordinator. Idle/hidden states initiate no new work; an already requested bounded operation can complete while hidden. Offline failure stops without automatic retries. Endpoint/key changes invalidate the receipt and suggestions. Cancellation/unmount discards late completions. Catalog writes occur on blocking workers under native/catalog locks; no cloud or history-ingestion path changes. Multi-instance writes use the existing target locks and revision checks.

Native GUI lifecycle CPU/RSS, hidden-window measurements, Windows runtime and direct-secondary launch were not run. No performance improvement is claimed. Local isolated CLI testing proves request routing, not GUI resource usage.

Performance verdict: blocked — native CPU/RSS and GUI lifecycle measurements are unverified; structural bounds and cancellation have automated evidence.
