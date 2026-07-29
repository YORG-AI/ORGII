# Unified Journey and Context Storyline PRD

Status: implementation baseline

Upstream reference: `Abudulaz/context-visualizer` at commit `bfd2b50d7ecb8bdbfff456bcbe00e7422311c759` (MIT).

## Outcome

ORG2 exposes one trustworthy Journey graph through Session and Project scopes. Project, WorkItem, Session, Turn, checkpoint, file artifact, and commit are facts. Topic, title, milestone type, abandon/pivot classification, and semantic hand-off are optional annotations. Every visible item has exact provenance.

## Decisions

1. Session and Project views query one graph; they do not independently infer lineage.
2. Continue from history defaults to Fork & Continue. In-place rewind is advanced and destructive.
3. Mainline change order is fork, verify branch/workspace, pin primary, then soft-prune the old continuation.
4. Prune changes narrative visibility only; it never deletes canonical records.
5. AI annotations are optional. The factual Journey works when annotation is disabled or failed.
6. There is no silent provider, provenance, rerank, or weaker-result fallback.

## Context Visualizer boundary

Adopt: real-time x-axis with explicit idle compression; agent lanes; topic ribbons; typed milestones; hand-off connectors; source drill-down; coverage ledger plus independent source audit; stable incremental layout.

Do not copy: standalone Node server; OpenRouter-only distillation; raw Claude JSONL as ORG2 truth; fixed dark single-file SVG UI; time-nearness rendered as factual hand-off; AI thread parents/excerpts persisted as truth; user-turn annotation coverage presented as project completeness.

Substantial copied implementation must retain the upstream MIT notice. Reimplemented concepts receive attribution in release notes and third-party notices.

## Graph contract

Stable node references: `project/{id}`, `work_item/{id}`, `session/{id}`, `turn/{session}/{turn}`, `checkpoint/{id}`, `artifact/{source}/{id}`, `file/{repo}/{path}`, and `commit/{repo}/{sha}`.

Edge kinds: `contains`, `run_of`, `next_turn`, `forked_from`, `resumed_from`, `compacted_to`, `handoff_to`, `produced`, `modified`, `validated_by`, `committed_in`, `supersedes`, and `curated_sequence`.

Every edge has one evidence class: canonical, deterministic derived rule, AI annotation, or reversible user overlay. Timestamp is display metadata and never an authoritative fork anchor. Exact lineage uses session, turn/event/message/sequence, and parent revision.

## Coverage contract

Every canonical source unit is `represented`, `merged_into`, `excluded` with a typed reason, or `uncovered`. Uncovered fails the trust gate. The independent audit re-reads canonical Turn, Session, WorkItem, and artifact stores instead of trusting projector labels. Provenance integrity and AI annotation coverage are separate indicators.

## Information architecture

- Shared toolbar: breadcrumbs, Session/Project scope, Storyline/Branches/File Lineage view, time/agent/topic/evidence filters, search, coverage, fit, and keyboard help.
- Storyline: real-time x-axis, agent lanes, WorkItem chapter track, optional topic ribbons, typed milestones, compact file activity, evidence-coded hand-offs.
- Branches: factual tree/DAG centered on the primary branch with active, failed, archived, and soft-pruned paths.
- File Lineage: WorkItem -> Session -> Turn/Artifact -> File -> Commit/Final Diff, with only canonical ORG2/orgtrack evidence producing solid edges.
- Inspector: Overview, Evidence, and Operations. Destructive actions are never hover-only.

## Semantic zoom

- Z0 Project: WorkItem chapters, activity density, major branches and hand-offs.
- Z1 Workflow: sessions, topic ribbons, forks, artifacts, and verifies.
- Z2 Turn: visible turns, state, duration, files, and short input.
- Z3 Evidence: source message, IDs/sequences, diff, provenance, and annotation metadata.

Zoom changes only the view model and never drops ledger entries.

## Mutation safety

Every mutation has preview, idempotency key, expected version, immutable operation record, and compensating/undo operation.

- Fork preserves the parent, inherits complete Project/WorkItem/agent/model/account/key/workspace identity, uses an isolated worktree for historical file state, and fails closed on stale anchors. Context-only fork requires explicit labelled consent.
- Prune applies to a branch edge and narrative subtree only; restore reverses the specific operation.
- In-place rewind previews removed turns/branches/files, archives transcript tail and file redo state first, and runs as a recoverable saga. Later writes force restore-as-fork.
- Normal delete is soft-delete/trash and preserves provenance. Hard delete is retention/admin-only.

## Delivery order

### P0 — Restore release capability and gates

Restore config-driven Embedding + Rerank UI/backend on the clean Journey branch; use Rules, Memory & Evolution -> Memory Retrieval as canonical placement; Models & Keys links to it; remove silent rerank fallback; add i18n, round-trip, failure, navigation, and rendered discoverability tests. No install before this gate passes.

### P1 — Unified read-only graph

Introduce shared graph/evidence/coverage contracts; project canonical Turns, recursive Session lineage, normalized WorkItem links, orgtrack artifacts, and commits; remove timestamp fork anchoring and first-linked-session file ownership; fail closed on missing/partial Project data; add independent audit.

### P2 — Storyline renderer and navigation

Build Session and Project scopes over the shared graph; ship Storyline, Branches, and File Lineage with Z0-Z3 LOD; preserve cross-page chat jump; open child Session, WorkItem, file, and diff; meet theme, keyboard, equivalent-list, reduced-motion, and i18n requirements.

### P3 — Persisted overlays

Add versioned primary mainline, curated sequence, prune/restore, optimistic concurrency, operation audit, and metadata undo. Do not mutate transcript or filesystem in this phase.

### P4 — AI annotation and trust surface

Add incremental topics/milestones/hand-offs through explicitly configured TiyGate models with source ranges and model metadata, no implicit fallback, and independent annotation coverage. Failure never removes factual Journey.

### P5 — Safe fork/reopen, then rewind

Implement preview/execute fork_from_node, isolated worktree, exact anchor, trash/recovery, filesystem saga/crash recovery, archived-tail rewind, and restore-as-fork after later writes.

## Acceptance gates

- One graph source; no parallel Session/Project truth inference.
- Every factual node/edge has canonical source; all derived/AI relations are visibly marked.
- Independent audit reports zero uncovered canonical units.
- Child Session, Turn, WorkItem, file, and diff navigation uses production paths.
- Fork leaves parent unchanged; prune changes no canonical row count and is reversible.
- 10k turns / 100 sessions / 20 agents is interactive within 2s on target hardware, p95 interaction <=100ms, and <=1,500 visible interactive nodes at Z0/Z1.
- Light/dark/high-contrast/reduced-motion/keyboard/equivalent-list pass.
- Rust/TypeScript tests, rendered UI E2E, architecture audit, frontend UI audit, license audit, and capability/discoverability smoke pass before build/install.

## Architecture audit lenses

1. Compilation/clippy/TypeScript checks are per-phase gates.
2. Integrate and delete old projectors/renderers in the same phase; no aspirational parallel graph.
3. Keep restore-pruned, restore-checkpoint, rewind, fork, archive, and delete as distinct typed terms.
4. Define session, mainline, coverage, hand-off, and source in one glossary.
5. Unknown variants fail closed and never render as canonical facts.
6. Visualization owns layout, not Session/Project truth.
7. Evidence class is mandatory at every boundary.
8. Serialized graph/annotation payload tests assert no unintended transcript bodies or secrets.
9. Session, Project, import, restore, and E2E initialize the same projector.
10. Canonical -> derived -> annotation -> overlay resolution is symmetric with explicit missing states.

## Non-goals for first release

Canonical branch deletion; AI topics as WorkItem truth; silent model/provider fallback; Context Visualizer Node server in production; arbitrary historical file restore before exact reversible checkpoints; installation of the superseded 2026-07-29 17:09 artifact.
