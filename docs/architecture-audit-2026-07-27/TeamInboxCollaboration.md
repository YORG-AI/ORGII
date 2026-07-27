# Architecture Audit — Team Inbox Multi-User Collaboration

**Scope:** structured member mentions, durable viewer-scoped read receipts, authoritative unread counts, full-roster Work Item identity projection, and dual-instance UI coverage.
**Date:** 2026-07-27

## Layer 1 — Compilation correctness

- TypeScript `tsc --noEmit`: passed.
- Focused ESLint over all changed collaboration/UI files: passed.
- Twenty-four focused Vitest files: 229 tests passed after rebasing onto the latest `develop` and adding capability-gate regression coverage.
- Cloud migration was statically reviewed; live apply and live two-account E2E remain deployment validation.

## Layer 2 — Dead code and structural deduplication

- Removed the cloud mention localStorage receipt owner; server receipts are now the sole cross-device source of truth.
- `resolveMentions` and `MemberMentionChip` own repeated UUID-to-name and pill UI logic.
- Session comments load the active roster through the existing shared roster coordinator rather than adding a second fetch/cache.
- Work Item history, description creator, assignee, and reviewer all project the same roster identities.

## Layer 3 — Naming consistency

- `mentionedUserIds` is used consistently on client wire/domain models; PostgreSQL uses `mentioned_user_ids`.
- `readAt` denotes the viewer-specific receipt timestamp, while `unreadCount` denotes the authoritative full-result total.
- `markAllTeamInboxMentionsRead` is explicitly org/viewer scoped rather than implying a global Inbox mutation.

## Layer 4 — Semantic overloading

| Term            | Meaning                                                        | Verdict                                                     |
| --------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| mention         | Explicit active-org member UUID attached to a comment          | Never inferred from display text.                           |
| read            | Receipt for one authenticated viewer and one mentioned comment | Separate from comment resolution or Session state.          |
| unread count    | Full eligible mention total outside the current page           | Owned by the server response, not derived from loaded rows. |
| member identity | Stable user UUID with roster-projected display name            | IDs persist; names may change without rewriting history.    |

## Layer 5 — Default branch analysis

- Old cloud deployments report no `teamInboxMentions` capability, so the structured picker stays hidden.
- Comment adds without mentions retain the legacy RPC; adds with mentions require the atomic 0010 RPC and never silently drop recipients.
- The view owns optimistic read/unread presentation and per-item rollback generations. The data source serializes the corresponding durable mutations through a bounded queue, so rapid opposite actions cannot commit out of order.
- Empty, loading, pagination, filtered, and partially loaded Inbox states preserve the server unread total.

## Layer 6 — Cross-domain concept leakage

- PostgreSQL owns durable receipts, recipient validation, visibility, retention, and authoritative totals.
- Org2Cloud clients own wire validation and transport retry only.
- Team Inbox owns list/filter/optimistic presentation, not receipt persistence.
- Session comments own member selection and mention rendering.
- Work Item components own assignee/reviewer/history identity presentation.

## Layer 7 — New developer confusion test

- No caller supplies a viewer ID to receipt RPCs; `auth.uid()` is always authoritative.
- The server accepts recipient UUIDs only after validating active membership in the target org.
- The capability flag documents the required server/client rollout order.
- Local single-user assigned items and cloud mention items remain distinct data-source branches with one normalized Inbox model.

## Layer 8 — Wire protocol and serialization

- `cloud_add_session_comment_with_mentions` atomically writes the comment and its deduplicated recipient UUIDs.
- Existing `cloud_list_session_comments` keeps its signature and legacy keys, adding `mentionedUserIds`.
- Mention list rows add `readAt`; the page adds `unreadCount` and a keyset `nextCursor`.
- Receipt mutations return both the resulting `readAt` and a fresh authoritative `unreadCount`.
- Zod schemas reject malformed wire state before it enters UI state.

## Layer 9 — Init parity

- Initial Inbox load and pagination both use the same mention projection; only the first page replaces the authoritative count.
- The initial cloud projection is capability-gated. A pre-0010 backend keeps local assigned items available without attempting a missing RPC.
- Reopened comment surfaces load persisted recipient IDs from the ordinary comment list.
- Roster loading is keyed by endpoint/account/org/revision and discards stale identity results.
- Account/org changes evict the previous projection in a layout effect before paint; page and mutation completions carry a load generation and cannot repopulate the new identity with old rows.
- Both primary and secondary desktop instances exercise the production UI/data paths in the extended E2E scenario.

## Layer 10 — Resolver symmetry

- Owner, assignee, reviewer, comment author, and mentioned recipient all resolve through the active org roster.
- Mark-read, mark-unread, and mark-all share the same eligibility rules as list/count: membership, retention, deletion, visibility, and active sharing.
- Restricted Sessions are visible only to owner or active grantees across both list and count paths.
- The owner does not receive another member's targeted mention projection unless explicitly included as a recipient.

## Completion verdict

- Architecture verdict: pass for Layers 1–10 in the implemented scope.
- Deployment gate: apply cloud migration `0010_team_inbox_mentions.sql` before shipping the desktop capability-enabled experience.
- Remaining production proof: run the managed-cloud two-account E2E after the migration is applied.
