# P2 — Read-Only Journey Visualization (Storyline / Branches / File Lineage / Coverage Ledger)

Branch: ash/org2-journey-context-viz-20260729
Worktree: /mnt/panshuainan/org2-journey-context-viz-20260729
PRD: docs/product/journey-context-visualizer-prd-20260729.md (authoritative)
Builds on P1: docs/product/P1_TASK_SPEC.md + p1-unified-graph-gate-20260730.md

## Goal (P2 only)
Render the ALREADY-UNIFIED read-only Journey graph (from P1 `journey_graph_query`) as real
visualizations. NO new truth, NO inference, NO mutation. Pure view over the P1 payload.

Deliver these read-only views, all fed by the single `journeyGraphQuery(scope)` payload:
1. Storyline timeline — real-time x-axis with EXPLICIT idle compression; agent lanes; typed milestones.
2. Branches view — forked_from / resumed_from / compacted_to lineage as a graph/tree.
3. File lineage view — file nodes with produced/modified edges (drill to source_ref).
4. Coverage ledger — represented / merged_into / excluded(reason) / uncovered, plus an
   independent-audit indicator (provenance integrity SEPARATE from coverage).

## Hard constraints (violate = fail)
1. Read-only. No overlay/prune/pin/fork/rewind (those are P3+). No writes, no new tauri mutation commands.
2. Consume ONLY the P1 payload shape (JourneyGraphPayload: nodes/edges/coverage with evidenceClass+sourceRef).
   Do NOT re-query raw stores or re-infer lineage in the frontend.
3. Timestamp is display-only. x-axis position may use displayTimestamp, but a hand-off/branch line
   MUST come from an actual edge (forked_from/resumed_from/handoff_to), never from time-nearness.
4. No silent fallback. If payload is partial/uncovered, the view fails closed (P1 client already throws);
   surface the error, never fabricate nodes/edges/demo data.
5. Every rendered node/edge shows its evidenceClass and is drillable to sourceRef.
   AI-annotation and user-overlay classes may appear in the legend but are NOT produced in P1/P2.
6. Idle compression must be EXPLICIT and visible (e.g. a labeled gap marker), never silently collapse real time.
7. Minimal deps. Prefer existing chart/layout libs already in package.json. If a new viz dep is truly needed,
   justify in the commit message; do NOT add a heavy graph engine casually.
8. Do NOT copy the upstream context-visualizer Node server, OpenRouter distillation, or its single-file dark SVG.
   Reimplemented concepts get attribution in release notes if substantial.
9. Layout must be stable/incremental (no jitter on refresh). Deterministic ordering by lineage+sequence, not hashmap order.
10. Do NOT install, build .deb, or mutate /usr/bin/org2. Do NOT touch live user config/creds. Do NOT push (Ash pushes).

## Existing seams to build on
- FE client: src/api/tauri/journeyGraph/index.ts (journeyGraphQuery, JourneyGraphPayload, EvidenceClass).
- FE adapter: src/modules/ProjectManager/JourneyGraph/viewModel.ts (pure mapping; extend, keep pure).
- Current minimal view: src/modules/ProjectManager/ProjectJourney/ProjectJourneyPage.tsx (node cards) — upgrade to real views.
- Session scope: same journeyGraphQuery("session/{id}") — Session Journey surface must reuse the SAME view components.
- Node kinds: project/workItem/session/turn/checkpoint/artifact/file/commit.
- Edge kinds: contains/runOf/nextTurn/forkedFrom/resumedFrom/compactedTo/produced/modified/validatedBy/committedIn.
- Coverage: represented | mergedInto{target} | excluded{reason} | uncovered.

## Deliverables
Frontend (TS/React, pure view):
1. A viewModel layer extension that derives, from the P1 payload only:
   - timeline lanes (per agent/session) with explicit idle-gap segments
   - branch tree from forkedFrom/resumedFrom/compactedTo edges
   - file-lineage adjacency from produced/modified edges
   - coverage summary + audit/provenance indicators
   All pure functions, deterministic ordering, no inference of missing links.
2. Presentational components: StorylineTimeline, BranchesGraph, FileLineagePanel, CoverageLedger.
   Each shows evidenceClass badges and drill-to-sourceRef.
3. A tabbed Journey container that switches these views; used by BOTH Project and Session scopes.
4. Fail-closed + loading + empty states wired to the existing throwing client.
5. Vitest for every new pure viewModel function: idle compression correctness, branch edges only from
   real edges (never timestamp), file lineage from produced/modified only, coverage/uncovered surfaces,
   deterministic ordering. Component smoke tests for evidence badge + drill target rendering.

Optional backend (ONLY if strictly needed for a view and still read-only):
- If a view needs a field the payload lacks, extend the P1 read-only projector/query minimally,
  keep evidenceClass+sourceRef mandatory, add Rust tests, document why. Prefer FE-only if possible.

## Gates (must pass before "done")
- npx vitest run <new P2 test files> — PASS
- NODE_OPTIONS="--max-old-space-size=8192" npx tsc --noEmit --pretty false — P2-touched files must add ZERO new errors
  (baseline currently = 10 pre-existing errors in keyVault/ProjectsTab/projectTree; stay at 10).
- If backend touched: docker run --rm -v "$PWD:/workspace" -w /workspace/src-tauri org2-build:22.04
  cargo fmt --all -- --check ; cargo test -p orgtrack_graph ; cargo clippy -p orgtrack_graph -- -D warnings
- Write docs/product/p2-journey-viz-gate-20260730.md (capability matrix + exact commands + evidence paths, mirror P1 gate doc).

## Workflow
1. FIRST append a P2 section to PLAN.md (exact files + approach per view). Do not code before the plan.
2. Implement viewModel pure layer -> components -> tabbed container -> wire Project & Session -> tests -> gate doc.
3. One commit per deliverable: feat(p2): / test(p2): / docs(p2): .
4. Commit with: git -c core.hooksPath=/dev/null commit --no-verify  (husky bootstrap is absent in this worktree).
5. Do NOT push (Ash handles origin push after verifying gates).
6. When fully finished run:
   openclaw system event --text "Done: P2 journey visualization (storyline/branches/file-lineage/coverage) complete, gate doc written" --mode now

## Non-goals (P2)
Overlays/prune/pin/persisted mainline (P3). AI annotations/topics (P4). Fork/rewind/any mutation (P5).
Upstream Node server / OpenRouter distillation / single-file SVG. Any install/build/deb/live-config.
