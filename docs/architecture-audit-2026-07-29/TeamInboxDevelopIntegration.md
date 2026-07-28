# Architecture Audit — Team Inbox on current `develop`

**Scope:** Clean extraction of Team Inbox, collaborative Work Item threads, and Session handoff from the mixed RPC branch onto `origin/develop`.
**Date:** 2026-07-29
**Auditor:** Codex

## Acceptance criteria

- [x] The branch is based on the current `origin/develop`.
- [x] RPC, Onboarding, performance-refactor, and Kanban-refresh source changes are absent.
- [x] Team Inbox is a persisted singleton ChatPanel tab with one sidebar route.
- [x] Sidebar unread state and Team Inbox content share the canonical Team Inbox cache.
- [x] Session drag and context-menu entry points converge on the same review/create state machine.
- [x] Work Item handoff persistence, collaboration projection, accept/return transitions, and retry behavior remain intact.
- [x] Current `develop` organization-tab and modular-sidebar ownership are preserved.

## Ten-layer audit

| Layer                                     | Coverage                                                                                                                                                                                | Verdict |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| 1. Compilation correctness                | Full TypeScript typecheck, 305 focused frontend tests, focused Rust tests, full `org2` cargo check, changed-file ESLint, changed-Rust rustfmt, and `git diff --check`.                  | Pass    |
| 2. Dead code and structural deduplication | Sidebar click routing opens the same singleton tab factory used by all Team Inbox entry points; Work Item details use the shared thread surface.                                        | Pass    |
| 3. Naming consistency                     | `team-inbox`, `TEAM_INBOX_MENU_ITEM_ID`, `openTeamInboxTab`, and localized `teamInboxLabel` retain one meaning across model, routing, and UI.                                           | Pass    |
| 4. Semantic overloading                   | Inbox read receipts, Work Item assignment, human handoff status, and Session provenance remain separate facts.                                                                          | Pass    |
| 5. Default branches                       | Tab rendering and sidebar routing handle Team Inbox explicitly; it cannot fall into Runtime, Work Management, or Organization defaults.                                                 | Pass    |
| 6. Cross-domain leakage                   | Inbox orchestration stays in `modules/MainApp/TeamInbox`; durable Work Item transitions stay in project management; sidebar modules only route and display unread state.                | Pass    |
| 7. New-developer clarity                  | The latest modular sidebar keeps atom binding, labels, pinned data, routing, and chrome forwarding in their named owner modules.                                                        | Pass    |
| 8. Wire protocol and serialization        | The extraction retains the tested Team Inbox DTO and Work Item `handoff` serialization without importing RPC protocol changes.                                                          | Pass    |
| 9. Init parity                            | Sidebar selection, persisted-tab restore, context-menu handoff, and drag/drop all reach the same canonical owners.                                                                      | Pass    |
| 10. Resolver symmetry                     | Sender and recipient identities use project-member resolution consistently; the latest `develop` organization model is retained rather than reintroducing old cloud/local tab variants. | Pass    |

## Lifecycle and ownership

| Transition           | Owner                              | Completion / recovery                                                |
| -------------------- | ---------------------------------- | -------------------------------------------------------------------- |
| Sidebar → Team Inbox | ChatPanel tab atoms                | Focus existing singleton or create one tab                           |
| Session → preview    | Team Inbox handoff request state   | Cancel without mutation, or submit one bounded intent                |
| Preview → Work Item  | Project Management atomic write    | Reuse compatible item or create; surface retryable failure           |
| Recipient response   | Work Item handoff state machine    | Accept, return with reason, idempotent replay, or explicit rejection |
| Collaboration update | Work Item collaboration projection | Reconcile the canonical persisted handoff and Inbox projection       |

## Completion verdict

The clean branch preserves the complete Team Inbox collaboration lifecycle while removing the unrelated RPC/performance stack. Remaining risk is rendered two-account operational QA, not an unresolved code or persistence path.
