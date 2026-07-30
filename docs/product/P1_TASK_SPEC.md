# P1 — Unified Read-Only Journey Graph

Branch: ash/org2-journey-context-viz-20260729
Worktree: /mnt/panshuainan/org2-journey-context-viz-20260729
PRD: docs/product/journey-context-visualizer-prd-20260729.md (authoritative)

## Goal (P1 only)
Introduce ONE shared, read-only Journey graph that both Session and Project scopes query.
Session and Project views MUST NOT independently infer lineage anymore.
Deliver graph/evidence/coverage CONTRACTS + a canonical projector + an independent audit.
Do NOT build the storyline renderer (P2). Do NOT add overlays/mutation (P3+).

## Hard constraints (violate = fail)
1. Minimal, in-scope changes only. No unrelated refactors.
2. No new heavy deps without justification in commit message.
3. No silent provider/provenance/rerank/weaker-result fallback anywhere.
4. Every node/edge carries exactly ONE evidence class: canonical | derived_rule | ai_annotation | user_overlay.
   In P1 only canonical and derived_rule may be PRODUCED.
5. Timestamp = display metadata ONLY. Never a fork/lineage anchor.
   Lineage anchors = session id + turn/event/message/sequence + parent revision.
6. Remove "first-linked-session file ownership" heuristic. File ownership comes from canonical
   produced/modified edges, not "first session that touched it".
7. Fail closed on missing/partial Project data. Never render a guessed node as canonical.
8. Independent audit RE-READS canonical stores (Turn/Session/WorkItem/artifact); it must NOT trust
   projector output labels. Uncovered canonical unit => audit fails the trust gate.
9. Per-phase gates must pass before "done" (see Gates).
10. Do NOT install, build .deb, or mutate /usr/bin/org2. Do NOT touch live user config/creds.

## Existing code to build on (do not reinvent)
- src-tauri/crates/orgtrack-graph/: schema.rs (nodes/edges tables), store.rs (GraphStore),
  project.rs (project_record_to_graph projector), query.rs (GraphNeighbor).
- src-tauri/crates/orgtrack-sync/src/records.rs: GraphNodeType, GraphEdgeType.
- Frontend to UNIFY (then delete old inference in THIS phase):
  - src/modules/ProjectManager/ProjectJourney/model/buildJourney.ts (Project inference — remove inference,
    point at shared graph query result)
  - src/modules/WorkStation/CodeEditor/SessionReplay/ + Session lineage inference (point at shared graph)

## Graph contract (align to PRD "Graph contract")
Stable node refs: project/{id}, work_item/{id}, session/{id}, turn/{session}/{turn}, checkpoint/{id},
artifact/{source}/{id}, file/{repo}/{path}, commit/{repo}/{sha}.
Edge kinds in P1 (canonical/derived only): contains, run_of, next_turn, forked_from, resumed_from,
compacted_to, produced, modified, validated_by, committed_in.
(handoff_to, supersedes, curated_sequence are P2/P3 — may add to enum but DO NOT synthesize in P1.)
Extend GraphNodeType/GraphEdgeType as needed; keep serde camelCase + existing variants.
Every edge payload MUST include: evidenceClass (canonical|derivedRule); sourceRef (recordId /
sessionId+seq / parentRevision / commit sha). NEVER a bare timestamp as the anchor.

## Coverage contract
Every canonical source unit is exactly one of: represented | merged_into | excluded(reason) | uncovered.
uncovered => trust gate FAIL. Provenance integrity and (future) AI-annotation coverage are SEPARATE indicators.

## Deliverables
Backend (Rust, agent-core + orgtrack-graph):
1. Canonical projector ingesting: canonical Turns, recursive Session lineage
   (resumed_from/compacted_to/forked_from), normalized WorkItem links, orgtrack artifacts, commits — into shared graph.
2. Remove timestamp fork anchoring; use exact parent revision / resumed-from session id.
3. Remove first-linked-session file ownership; derive file ownership from produced/modified edges only.
4. Independent audit module: re-reads canonical stores, emits coverage + provenance reports; fails closed on uncovered.
5. Read-only query command (agent-core command / gateway method) returning unified graph scoped by
   project/{id} or session/{id} with evidence classes intact.
6. Rust unit tests: projector correctness, no-timestamp-anchor, coverage uncovered=>fail, evidence class mandatory.

Frontend (TS/React):
1. Single graph client hook calling the read-only command; Session & Project pages both consume it.
2. Delete/replace the two independent inference paths so there is ONE source; keep pure view-model mapping only.
3. Vitest: both scopes resolve from the same graph payload; evidence class surfaces; missing/partial fails closed.
4. No renderer work beyond wiring existing minimal Journey view to the new payload.

## Gates (must pass before "done")
- cargo fmt --all --manifest-path src-tauri/Cargo.toml -- --check
- cargo test -p orgtrack_graph ; cargo test -p agent_core <new modules> (docker org2-build:22.04 if host lacks gtk)
- cargo clippy touched crates — zero NEW diagnostics in touched files (baseline may be dirty; document)
- npm run typecheck — zero NEW diagnostics in touched TS files
- Focused Vitest for new/changed FE files — PASS
- Write docs/product/p1-unified-graph-gate-20260730.md (capability matrix + exact commands + evidence paths, mirror P0 gate doc).

## Workflow
1. FIRST update PLAN.md (P1 section): exact files touched + approach per deliverable. Do not code before the plan.
2. Implement backend contracts + projector, then audit, then query command, then frontend unification.
3. One commit per deliverable: feat(p1): / refactor(p1): / test(p1): .
4. Do NOT push to origin (auth blocked historically). Local commits only.
5. When fully finished run:
   openclaw system event --text "Done: P1 unified journey graph (contracts+projector+audit+FE unify), gate doc written" --mode now

## Non-goals (P1)
Storyline/Branches/File-Lineage renderer (P2). Overlays/prune/pin/persisted mainline (P3).
AI annotations (P4). Fork/rewind mutations (P5). Any install/build/deb.
