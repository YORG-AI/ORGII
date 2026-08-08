# Architecture Audit — Team Inbox Work Item Source

**Scope:** assigned Work Item repository source from SQLite through the Team Inbox Rust/TypeScript wire boundary and shared list row

**Date:** 2026-07-30

## Findings

| Priority | Area                  | Final verdict | Evidence                                                                          | Resolution                                                                                                                                                                                |
| -------- | --------------------- | ------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2       | Source ownership      | fixed         | `TeamInboxRow` previously formatted `target.projectId`, which is the project slug | The existing assigned-item query now projects the first repository from the owning project's persisted `linked_repos_json`; presentation no longer treats a project slug as a repository. |
| P2       | Wire semantics        | fixed         | `TeamInboxTarget::WorkItem` had project identity but no repository source         | Added an optional `repository` field to the Work Item target and mapped it once at the Rust/TypeScript boundary. Projectless items omit the field.                                        |
| P3       | Presentation fallback | fixed         | Ten-character truncation turned `orgii-issues…` into the misleading `orgii-issu`  | Work Item metadata renders `repository issue` from the synced repository's final path segment, or localized `Issue` when no repository exists.                                            |

## Ten-layer coverage

| Layer                      | Verdict                            | Notes                                                                                                                                                                                              |
| -------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation             | pass with unrelated clippy blocker | TypeScript typecheck, targeted tests, Rust Team Inbox tests, and `cargo check` pass. Strict all-target clippy reaches only pre-existing `field_reassign_with_default` findings outside Team Inbox. |
| 2. Dead code / duplication | pass                               | Removed the Work Item use of the generic metadata appender; the compact repository formatter remains shared with pull-request rows.                                                                |
| 3. Naming                  | pass                               | `repository` describes the persisted repository source; `projectId` remains navigation/project identity.                                                                                           |
| 4. Semantic overload       | fixed                              | Project slug and repository source are no longer represented by the same UI value.                                                                                                                 |
| 5. Defaults                | pass                               | Missing repository data produces an explicit issue-only fallback instead of falling back to an unrelated project slug.                                                                             |
| 6. Layer boundaries        | pass                               | SQLite owns persisted project scope, the wire target transports it, and the row owns truncation/type copy.                                                                                         |
| 7. Control flow            | pass                               | The source is projected in the existing bounded assigned-item query; no secondary lookup or asynchronous branch was added.                                                                         |
| 8. Wire protocol           | pass                               | Rust serialization and TypeScript mapping tests assert the optional repository field and its omission for standalone items.                                                                        |
| 9. Init parity             | not applicable                     | No initialization path changed.                                                                                                                                                                    |
| 10. Resolver symmetry      | pass                               | Every project-scoped assigned row uses the same first-linked-repository rule; every projectless row uses the same absent-source fallback.                                                          |

## Performance guard

| Area                     | Verdict | Evidence                                                                                                                       |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Background work          | keep    | No timer, poller, subscription, retry, worker, or extra query was added.                                                       |
| Query scope              | keep    | One nullable scalar is extracted from the already joined project row inside the existing cursor-paginated query.               |
| Memory                   | keep    | At most one optional repository string is retained per already bounded Team Inbox row.                                         |
| Rendering                | keep    | Final-segment normalization and ten-character truncation are linear in one short source string and run only for rendered rows. |
| Multi-instance isolation | keep    | Repository scope comes from the same `project_id` join as the Work Item, with no global or cross-org repository lookup.        |

**Performance verdict:** pass. The change preserves the existing bounded query, cache, and render lifecycles.

## Verification

- `npm run typecheck` — passed.
- Scoped ESLint and Prettier checks — passed.
- Team Inbox Vitest suite — 20 files / 118 tests passed.
- `cargo test --manifest-path src-tauri/Cargo.toml -p project_management team_inbox -- --nocapture` — 15 tests passed.
- `cargo check --manifest-path src-tauri/Cargo.toml -p project_management --all-targets` — passed.
- Targeted `rustfmt --check` for the changed Team Inbox Rust files — passed.
- `cargo clippy --manifest-path src-tauri/Cargo.toml -p project_management --all-targets --no-deps -- -D warnings` — blocked by 34 pre-existing `field_reassign_with_default` findings in unrelated Work Item/sync tests.
