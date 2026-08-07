# Architecture Audit: Session Provenance

Scope: every file changed by the Session Provenance PR, including the extracted
protocol, canonical Orgtrack records, hook CLI and installers, SQLite storage,
historical reconciliation, RPC schemas, Session Blame UI, sidebar reveal, all
locales, documentation, and rendered E2E coverage. Unrelated key-vault changes
were explicitly removed from the final upstream diff.

| Layer                        | Area inspected                                                                                   | Verdict          | Reason                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Suggested change                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------ | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 1. Compilation               | Rust packages, desktop app, TypeScript boundary, E2E specs                                       | keep with reason | `cargo check -p org2` passes. Current focused suites pass: `orgtrack_protocol` 6 unit/integration tests plus its package-boundary test, `agent_cli` 20, `orgtrack_core` 189, app `orgtrack::` 14, and 22 focused frontend tests. Changed frontend files pass ESLint. Full TypeScript check reaches only the pre-existing untouched `ContextInfoButton.tsx:468` error. Strict clippy reaches only five pre-existing warnings outside this PR after all changed-code warnings were removed.                                                                                                      | Resolve the repository's unrelated TypeScript and clippy debt separately.                         |
| 2. Dead code / deduplication | Protocol types, classifiers, provider parsing, reconciliation, RPC and UI types                  | keep with reason | Removed unused lookup DTOs, stale translations, speculative `Reference` action and `Transcript` capture method, and an unused attribution field. Live hooks and historical import now share `resource_interaction` action/path/patch classification. Historical import calls the existing Claude/Codex/Cursor session list/load paths and normalized `ActivityChunk`; it does not introduce a second transcript parser.                                                                                                                                                                        | Keep new provider support behind the existing provider readers and shared classifier.             |
| 3. Naming                    | `ResourceInteractionEnvelopeV1`, `SessionActorLifecycleEnvelopeV1`, Session Provenance, locators | keep with reason | Names describe two different facts: resource activity and actor lifecycle. They avoid the ambiguous “file touches” label and do not overload actor, session, transcript, source DB, and Orgtrack store identities.                                                                                                                                                                                                                                                                                                                                                                             | Add a new version only for an incompatible wire change; do not rename fields in v1.               |
| 4. Semantic overloading      | Session/root/actor IDs, action, precision, capture method, source/store paths                    | keep with reason | Canonical session ID, provider session ID, parent session ID, and actor ID remain separate. Action has six supported values; capture method has three. Attribution precision records whether actor ownership was direct, correlated, or session-only. Original provider data locations are read-only source locators; the Orgtrack DB/spool are writable store locators and are never emitted in privacy-filtered envelopes.                                                                                                                                                                   | Preserve the distinction when the collector is extracted into a standalone package.               |
| 5. Default branches          | Unknown tools/events, incomplete hook configs, invalid inbox records, missing transcripts        | keep with reason | Unknown file-capable tools fail closed rather than fabricating an action. Hook installation checks the complete structural event/matcher set instead of trusting a marker. Invalid inbox files are quarantined. Transcript navigation is enabled only when a real transcript file exists.                                                                                                                                                                                                                                                                                                      | Add explicit mappings and fixtures when a provider adds a new tool/event family.                  |
| 6. Cross-domain leakage      | `orgtrack-protocol`, `orgtrack-core`, `agent-cli`, desktop orchestration, frontend               | keep with reason | The protocol crate depends only on serialization/schema concerns and contains no Tauri, SQLite, filesystem, ORG2, or provider implementation. `orgtrack-core` owns canonical classification, `agent-cli` owns vendor config/spooling, the desktop app owns persistence/reconciliation, and the frontend consumes projections.                                                                                                                                                                                                                                                                  | The later cloud/submodule extraction can move these packages without moving My Station UI policy. |
| 7. New-developer test        | Module layout, docs, operational boundaries                                                      | keep with reason | Live ingestion remains in `session_provenance.rs`; historical scheduling/checkpoints/provider reuse were split into `historical_backfill.rs`. The protocol README, package RFC, and `docs/session-provenance.md` explain storage, privacy, hooks, source/store paths, upgrades, and extraction. The provider E2E is now a focused spec rather than being hidden inside the Diff-tab spec.                                                                                                                                                                                                      | Keep E2E responsibilities split by observable product contract.                                   |
| 8. Wire / serialization      | Vendor JSON to v1 envelopes to SQLite JSON to Zod RPC                                            | keep with reason | Both resource and actor-lifecycle envelopes are strictly decoded. JSON Schemas enumerate the six actions, outcomes, and precision values. Negative tests reject prompts, commands, output, content, diffs, identities, source DB paths, and store paths. Deterministic observation IDs include capture method and actor so exact and reconciled facts cannot collide.                                                                                                                                                                                                                          | Add checked-in upstream payload fixtures when providers publish stable fixtures.                  |
| 9. Initialization parity     | Hook subprocess, desktop drain, native events, historical import, test harness                   | keep with reason | Hook subprocesses validate and atomically spool but never open the desktop DB. Desktop drain validates before persistence. Native events use the same canonical store. Historical import uses durable fingerprints and immediately requeries after terminal backfill. User preference is written before provider mutation, and returned state reflects actual installation; an unselect therefore removes a hook on the normal path and reports per-platform failure honestly.                                                                                                                 | A standalone collector must pass this same entry-point matrix before cutover.                     |
| 10. Resolver symmetry        | Repo/workspace/file/session/actor resolution and sidebar replay                                  | keep with reason | Live and historical paths share canonical provider prefixes and file-resource resolution. Claude actor IDs resolve to the same child identities produced by existing importers; Codex/Cursor promote transcript origins only after locating a real file. Session Blame folds participants whose effective replay target equals the root into the root aggregate; distinct children exact-load, reveal the correct time group, expand, select, scroll, and replay independently. Provider first-page refreshes preserve exact-loaded child rows, while disabling a provider still removes them. | Keep labels presentation-only; navigation must continue using canonical IDs and transcript proof. |

## Systematic sweeps

- Compared every PR path against `upstream/develop`, including generated schemas,
  all 13 locale files, Rust package manifests, frontend RPC types, hooks, state,
  tests, reports, and E2E documentation.
- Searched canonical session-ID construction across Claude Code, Codex, Cursor,
  native ORG2, historical import, SQLite queries, RPC output, and sidebar state.
- Searched all current file-capable event/tool mappings and verified that live and
  backfill paths converge on the same classifier.
- Exercised every supported user-level hook configuration and verified install,
  remount/readback, uninstall restoration, malformed-config reporting, and
  per-platform status behavior. Cursor completeness includes `postToolUse`,
  `subagentStart`, and `subagentStop`.
- Removed unrelated key-vault compatibility changes from the final upstream diff
  instead of coupling account migration behavior to Session Provenance.

## Term overloading table

| Term                 | Existing meanings found                                                           | Resolution                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| interaction outcome  | Agent-core response/cancel/timeout state; Orgtrack resource success/failure state | The protocol uses `ResourceInteractionOutcome`; agent-core retains its domain-local `InteractionOutcome<T>`.                          |
| session ID           | Provider session ID; ORG2 canonical root session ID; actor/child session identity | Separate source, canonical, parent, and actor fields; labels are never identity.                                                      |
| original DB path     | Provider history input; normalized Orgtrack destination                           | Read-only `SourceLocator` and writable `StoreLocator`; neither appears in an event envelope.                                          |
| actor lifecycle      | An agent/subagent starting or stopping                                            | `SessionActorLifecycleEnvelopeV1`; it proves hierarchy and transcript identity but does not pretend that a file interaction occurred. |
| resource interaction | A read/write/search/list/create/delete operation on a normalized resource         | `ResourceInteractionEnvelopeV1`; it may point at an actor established by lifecycle data.                                              |

## Initialization parity matrix

| Entry point                          | Normalize provider payload                 | Validate v1           | Atomic spool                                    | Desktop DB                  | Shared resolver |
| ------------------------------------ | ------------------------------------------ | --------------------- | ----------------------------------------------- | --------------------------- | --------------- |
| Claude/Codex/Cursor hook subprocess  | yes                                        | yes                   | yes                                             | no                          | desktop drain   |
| Desktop inbox drain                  | already normalized                         | yes                   | consumes published files; rejects invalid files | yes                         | yes             |
| ORG2 native event                    | typed native record                        | not a wire round-trip | no                                              | yes                         | yes             |
| Historical transcript reconciliation | existing provider reader + `ActivityChunk` | not a wire event      | no                                              | yes; fingerprint checkpoint | yes             |
| Protocol golden/schema tests         | not applicable                             | yes                   | no                                              | no                          | not applicable  |

## Rendered and live evidence

The real hook-settings test passed in an isolated home using a real pointer: it
enabled Codex, remounted the settings panel, reread the installed status, then
restored the original state. This verifies that the switch is stateful rather
than visual-only.

The focused provider E2E passed end to end with the locally authenticated Claude
Code, Codex, and Cursor CLIs. Each provider read and edited the same isolated
file through its real tools; production hooks emitted privacy-filtered records;
the desktop drained them into SQLite; historical backfill reconciled transcripts;
and My Station rendered Session Blame. It proved root and subagent transcript
identity, distinct root/child replay, sidebar group expansion/selection/scroll,
and absence of content sentinels from captured metadata.

An audit rerun initially exposed a race where a provider first-page refresh
could remove an exact-hydrated Codex child after the transcript had already
opened. The loader now preserves child rows across ordinary page replacement,
but not across provider disable. A focused regression test covers both branches,
and a fresh real-provider E2E then passed the previously failing child
expand/select/scroll assertion.

The independent native ORG2 Diff scenario was also launched, but its `before
all` stopped before product interaction because the isolated account database
contained no Codex account satisfying `gpt-5.5 + session token + Rust-agent
support`. Claude candidates were absent as well. This is recorded as an
environment/credential fixture blocker, not a passing product assertion and not
a Session Provenance regression.

## Session Blame to sidebar contract

| Boundary   | Verified behavior                                                                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPC        | `sessionIds?: string[]` is additive, Zod-validated, and exact-match; `session-1` cannot match `session-10`.                                                                                                 |
| Cache      | Canonical `session_id` has an idempotent index; explicit historical navigation can hydrate its requested root/child even when presentation filters hide it, without changing the user's source preferences. |
| State      | Reveal requests use monotonically increasing IDs, clear conditionally, uncollapse the sidebar, clear search, and open the containing time group.                                                            |
| DOM        | Canonical session ID is the row identity; scrolling occurs once per reveal request.                                                                                                                         |
| Transcript | Root and child are independently hydrated and selected; actor navigation is clickable only with a real transcript path.                                                                                     |

The implementation therefore supports the claimed chain:
`session -> actor/subagent -> resource interaction -> proven transcript replay`.
When a provider does not expose enough evidence, the record remains visible at
session-only precision instead of inventing subagent ownership.
