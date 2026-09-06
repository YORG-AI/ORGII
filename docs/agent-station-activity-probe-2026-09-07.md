# Agent Station activity probe

The child ranking consumer uses only whether a chat-visible event exists. Previously every off-page child called `es_load_from_cache` followed by `es_get_snapshot`, retaining native history and a derived JavaScript snapshot to compute a length.

The new additive `es_get_chat_activity` RPC accepts at most 64 session IDs and returns booleans. It reads existing store events without creating stores; otherwise SQLite visits one row at a time and stops at the first event accepted by the canonical chat-visibility predicate. It does not normalize sequences, import raw provider history, build derived snapshots, or cache event bodies. Empty/unimported histories preserve their original relative ordering until activity arrives or the view becomes visible again. Existing live snapshots can promote a child with newly produced activity.

No schema or persistence changes. Frontend/backend ship together; rollback is reverting the RPC and caller together. Providers whose raw history is not yet cached are intentionally not imported to rank off-page rows. Full transcript rendering remains the visible cell owner's responsibility.

Architecture review covered ownership, types, wire additions, initialization parity, identity, error paths, and resource lifetime (layers 1–10 as applicable); no domain identity or sync writers change.

| Area               | Verdict | Evidence                                                      | Change or reason kept                                                  | Verification                                       |
| ------------------ | ------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| Background work    | fix     | Effect owns subscriptions and batches                         | Stop subscriptions while hidden; no polling; visibility retries errors | Mounted hook visibility test                       |
| Memory             | fix     | One SQLite row at a time; scalar result map limited to roster | Stop on first match; no transcript hydration for ranking               | 1,000-row SQLite test visits only one matching row |
| Scope/isolation    | fix     | Effect disposal and request membership                        | Old-parent results rejected; identical in-flight RPC batches shared    | Mounted identity switch test                       |
| Rendering/hot path | fix     | Booleans publish per batch; positive flags stable             | Stream activity only promotes once                                     | Mounted hook tests; typecheck and lint             |

Performance verdict: blocked for real-app CPU/RSS and imported-provider transition measurements; computer control was not authorized. Automated tests and compilation verify structural allocation and lifecycle changes, not a numerical RAM improvement.
