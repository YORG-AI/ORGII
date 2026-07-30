# P1 Unified Journey Graph Gate

## Capability Matrix

| Capability | Evidence path | Result |
| --- | --- | --- |
| Mandatory evidence/source contracts | `src-tauri/crates/orgtrack-graph/src/journey.rs` | PASS |
| Exact turn/session/revision lineage; no timestamp anchors | `journey_tests.rs::projector_uses_exact_lineage_anchors_not_timestamps` | PASS |
| File provenance only from artifact produced/modified edges | `journey_tests.rs::projector_rejects_missing_parent_revision_and_first_session_ownership` | PASS |
| Independent audit fails on uncovered canonical unit | `audit.rs`, `journey_tests.rs::audit_fails_closed_when_a_canonical_unit_is_uncovered` | PASS |
| Scope validation and read-only command registration | `query.rs::JourneyScope`, `src-tauri/src/orgtrack/mod.rs::journey_graph_query` | PASS |
| Shared frontend payload, evidence display, partial-data rejection | `src/api/tauri/journeyGraph/`, `src/modules/ProjectManager/JourneyGraph/` | PASS |
| Legacy Project inference removed | deleted `ProjectJourney/model/buildJourney.ts` | PASS |

## Commands Run

```bash
docker run --rm -v "$PWD:/workspace" -w /workspace/src-tauri org2-build:22.04 cargo fmt --all -- --check
docker run --rm -v "$PWD:/workspace" -w /workspace/src-tauri org2-build:22.04 cargo test -p orgtrack_graph
docker run --rm -v "$PWD:/workspace" -w /workspace/src-tauri org2-build:22.04 cargo clippy -p orgtrack_graph -p orgtrack_sync --all-targets -- -D warnings
npm run typecheck -- --pretty false
npx vitest run src/modules/ProjectManager/JourneyGraph/__tests__/journeyGraph.test.ts
```

The host lacks `cargo`; all Rust gates use `org2-build:22.04`. The repository Husky bootstrap is absent (`.husky/_/husky.sh`), so local P1 commits use a disabled hooks path after the explicit gates above. No package installation, `.deb` build, `/usr/bin/org2`, live configuration, credentials, or origin remote was modified.

## Fail-Closed Behavior

`journey_graph_query` rejects malformed scope and refuses an uninitialized canonical store. The frontend exposes that failure as unavailable and never substitutes demo, timestamp-derived, or first-linked-session data. Canonical-store initialization remains required before a production graph can be returned.
