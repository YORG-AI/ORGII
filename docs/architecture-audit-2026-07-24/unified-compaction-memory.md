# Architecture Audit — Unified Compaction And Memory

**Scope:** `4e3f63535`, `2a704e61c`, and the compaction-lineage migration.

| Layer | Coverage | Verdict | Evidence / decision |
| --- | --- | --- | --- |
| 1 Compilation correctness | Rust/TypeScript checks scheduled in the Docker validation run. | pending verification | Host has no Cargo; verification runs in the repository Docker image. |
| 2 Dead code and deduplication | Traced embedding selection from integrations config through `AutoEmbeddingProvider`; traced compaction boundary persistence through `append_in_place_compact_boundary`. | keep with reason | `CompactionBoundaryRecord` is a persisted-query API requested for migration but has no production writer yet; do not invent a second compaction writer. Follow-up wiring must use the existing append/fork finalization points. |
| 3 Naming consistency | Checked `embedding_api`, compaction boundary, and lineage exports. | keep with reason | `agent_compaction_boundaries` is distinct from existing compact-message boundary rows; public APIs use the longer `compaction_boundary` name. |
| 4 Semantic overloading | Reviewed `boundary`, `model`, `route`, and `source`. | keep with reason | Message boundaries remain render-time transcript markers; lineage boundaries represent durable source/target range metadata. The table names make the distinction explicit. |
| 5 Default branches | Reviewed embedding provider policy and status-bar credential fallback. | fixed | Missing `ZENMUX_MGMT_KEY` yields unavailable quota text; it does not issue an unauthenticated request or stop delivery. |
| 6 Cross-domain leakage | Reviewed Feishu status bar and compaction lineage persistence. | fixed | Status-bar quota access is channel-scoped. The management secret is no longer embedded in agent-core source. |
| 7 New-developer clarity | Reviewed new schema and summary behavior. | keep with reason | The lineage module documents source-range retrieval; `COMPACTION_SCHEMA_VERSION` records the grill schema independently of message format. |
| 8 Wire/serialization | Reviewed embedding response ordering/source fingerprint and ZenMux quota HTTP call. | fixed | Embedding code validates response index/dimension; quota call uses an env-provided bearer token and a two-second timeout. No live credential/API call was made during audit. |
| 9 Init parity | Reviewed unified persistence init and isolated in-memory schema test. | keep with reason | `persistence::init` runs the lineage schema creation alongside existing message schemas. The unit test directly validates idempotence for isolated databases. |
| 10 Resolver symmetry | Reviewed compaction model/account and embedding provider resolution. | keep with reason | The current compaction processor resolves both model and account from the session runtime. Embedding configuration is resolved through one `from_config` path. |

## Follow-up

`save_compaction_boundary` and `next_compaction_index` are intentionally not called by a production compaction completion path yet. Adding that writer requires a single design decision about in-place versus fork boundaries; it must be wired once at the authoritative completion point, with a transaction or collision retry around index allocation.
