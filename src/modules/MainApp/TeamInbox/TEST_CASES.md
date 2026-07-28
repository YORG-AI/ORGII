# Team Inbox acceptance cases

## Automated

- The Sidebar pinned menu renders Team Inbox immediately below Runtime.
- Opening Team Inbox twice focuses the same singleton Chat Panel tab.
- `all`, `mentions`, and `assigned` filters operate on one discriminated item model.
- Mixed items are deduplicated and sorted by `occurredAt`, then stable item identity.
- Local assigned Work Items require explicit current-user member IDs.
- Local cursor pagination is stable when timestamps tie and when newer rows arrive.
- Local assignment and managed-cloud mention receipts are viewer-scoped and idempotent.
- Managed-cloud mention responses are Zod-validated, include server-owned `readAt` + full-page-independent unread totals, and never accept a caller-supplied viewer ID.
- Structured comment mentions send stable cloud user ids selected from the active roster; mutable/non-unique display names are never parsed as identities.
- Raw work-item status/priority enum tokens are humanized (`humanizeToken`) when no localized key exists, and never leak to the row or detail.
- Per-filter unread counts (`countUnreadTeamInboxItemsByFilter`) de-duplicate before counting and back the filter-tab badges.
- `filterItemKind` maps `all → null`, `mentions → comment_mention`, `assigned → assigned_work_item`.
- `searchTeamInboxItems` is case-insensitive, matches title/body/summary/people, returns a fresh copy for empty queries, and empty for no match.
- `groupTeamInboxItemsByRecency` buckets by local calendar day (Today/Yesterday/This week/Earlier), omits empty groups, keeps input order, and files unparseable timestamps under "earlier".
- Assigned items carry a trimmed, whitespace-folded, 240-char body excerpt as `summary`; blank bodies omit the field (`work_item_summary_excerpt`).
- `mark_unread` deletes the viewer-scoped local or cloud receipt so the item returns to unread and remains idempotent; cloud receipts are not owned by localStorage.
- `toWireCursorItemId` preserves the backend `work_item_assigned:` source prefix (strips only the UI `assigned_work_item:` kind prefix) so `Load more` cursor pagination round-trips instead of erroring.
- Sidebar and full Inbox consumers in the same Jotai store share one scope-keyed coordinator, including initial request identity, local/cloud cursors, mutation ordering, cancellation, and the bounded 500-row snapshot.
- Local and cloud reads settle independently: one successful source remains visible with a localized partial-success notice, and a failed pagination cursor remains retryable.
- Switching account, organization, or resolved viewer identity synchronously evicts the old snapshot, aborts cloud work, and prevents late responses from committing into the new scope.
- Exact account IDs, verified full email addresses, linked emails, and provider usernames may resolve a viewer; matching display names or equal email local-parts across domains never does.
- Reassigning a Work Item changes `assigned_human_id` and deletes the prior assignment episode's read receipt in the same SQLite transaction; agent assignments never enter the human-assignment projection.
- Failed read/unread persistence rolls back the coordinator-owned optimistic snapshot, while a newer per-item mutation supersedes an older response.

## Presentation / polish

1. Filter tabs (`All` / `Mentions` / `Assigned`) show a primary count badge only when that surface has unread items; badge clamps to `99+`.
2. Unread rows render a leading primary dot and bold title; read rows drop the dot and use medium weight.
3. Assigned rows show one title line, at most two plain-text excerpt lines, and a localized `status · priority` metadata line; Markdown syntax, escaped newlines, and redundant assignee names do not leak into the card.
4. Successful edits in the selected Work Item immediately update the matching list row's title, summary, status, priority, and assignee; reassigning away from the viewer removes the stale assigned row.
5. The list excerpt and detail Markdown body use the same `text-text-1` content token; hierarchy comes from size and weight rather than mismatched foreground colors.
6. Assigned detail shows localized `Status` and `Priority` rows and no misleading `Assigned by` row when no assigner is known.
7. `Mark all as read` in the header marks **only the active filter's** unread items (Mentions view never marks Assigned, and vice versa).
8. Empty state copy is filter-specific (`No mentions` vs `Nothing assigned to you`), falling back to the generic empty copy for `All`.
9. A `SearchInput` toolbar row filters the loaded items live; typing a non-matching query shows a dedicated `No matches` empty state (distinct from the filter-empty copy); clearing the query restores the list.
10. Rows are grouped under recency headers (`Today` / `Yesterday` / `This week` / `Earlier`); empty groups are hidden, and Arrow/Home/End keyboard navigation still traverses the flat visible order across group boundaries.
11. Selecting an assigned item lazily loads the full Work Item body and renders it as Markdown; while loading / on failure / when empty it falls back to the short list excerpt. Selecting a mention renders the comment body as Markdown. Stale body responses are discarded when the selection changes.
12. A read item's detail exposes a `Mark as unread` action; invoking it returns the row + Sidebar unread badge to the unread state (local assignment deletes the SQLite receipt; cloud mention deletes the managed-cloud receipt). Re-marking read still works after refresh or on another device.
13. When a source still has a next page, the list shows a `Load more` control—even when the active filter/search has no visible first-page result; invoking it appends the next page (local cursor round-trips with the `work_item_assigned:` prefix intact) and de-duplicates against the loaded set. The control hides once no source has more.
14. Activating Retry after an initial load error calls the backing source's refresh boundary before reading a new snapshot; it never loops on the same failed cache entry.
15. Partial-source degradation uses a warning treatment and preserves readable results; a total failure uses the blocking error state.

## Coordinator state machine

| State                | Entry                                                         | Visible behavior                                                                       | Allowed transition                                   | Ownership / persistence                                                   |
| -------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------- |
| Unavailable identity | Member files loaded but no exact viewer identity matches      | Cloud results may remain visible; local assignment availability is explicitly degraded | Refresh after profile/account correction             | Identity is derived; no guessed member id is persisted                    |
| Loading              | New viewer/account/org scope or explicit refresh              | Old scope is synchronously removed; the new scope shows loading                        | Success, partial success, empty, error, scope switch | Coordinator owns request generation and AbortController                   |
| Ready                | Every requested source succeeds                               | Shared list, counts, cursors, filters and detail are usable                            | Load more, mutation, refresh, scope switch           | Jotai cache is the canonical runtime snapshot                             |
| Empty                | Successful sources return no rows                             | Filter-specific empty state; Load more stays available when a cursor exists            | Load more or refresh                                 | Empty is a successful snapshot, not an error                              |
| Partial success      | At least one source/prerequisite succeeds and one degrades    | Successful rows stay actionable under a localized warning                              | Retry, pagination of remaining cursors, scope switch | Successful source data replaces only that source's projection             |
| Error / timeout      | Every requested source fails or prerequisite loading fails    | Blocking error only when no usable rows remain; retained rows otherwise stay visible   | Retry invokes the real refresh boundary              | Diagnostic details remain internal; UI maps issue codes to localized copy |
| Mutating             | Read/unread operation enters the shared mutation queue        | Snapshot updates optimistically once                                                   | Commit authoritative receipt, rollback, or supersede | Durable receipt is SQLite/cloud; optimistic state is coordinator-owned    |
| Superseded           | Scope generation changes or a newer same-item mutation starts | Late completion is ignored; cloud work is aborted best-effort                          | New scope/request continues                          | No stale completion may write the current snapshot                        |

## Unified Work Item thread

| #   | Steps                                                                                                                  | Expected result                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Select a project-scoped assigned Work Item.                                                                            | The full Work Item uses the shared content and property components; the reduced Markdown/metadata preview is not rendered.                                                        |
| 2   | Inspect a Work Item with linked Sessions.                                                                              | Workflow and Session run cards appear inline in one continuous thread. The legacy `Session / Output / History` tab strip and linked-Session table are absent in Team Inbox.       |
| 3   | Activate `View live chat` / `View conversation` on a Session card.                                                     | A separate Session Chat Panel tab opens or the existing tab for that Session is focused. Team Inbox remains open as its singleton tab.                                            |
| 4   | Inspect a Work Item with proof of work and comments/history.                                                           | Output and activity render inline after the workflow; no second nested detail surface is introduced.                                                                              |
| 5   | Switch assigned rows while the first full Work Item is still loading.                                                  | A late response from the first row never replaces the newly selected Work Item.                                                                                                   |
| 6   | Make two property changes in quick succession.                                                                         | Same-item writes run in invocation order through a bounded queue, so the final response contains both atomic partial updates and an older response cannot overwrite newer intent. |
| 7   | Open a standalone assigned Work Item.                                                                                  | The thread remains readable, but edit controls/property rail are not exposed because standalone persistence requires the owning frontmatter round-trip.                           |
| 8   | Fail the selected Work Item read.                                                                                      | A visible error placeholder is shown; the short list row remains available for retry/navigation.                                                                                  |
| 9   | Open a project Work Item with a short description.                                                                     | The description renders at its natural Markdown height. `Preview / Raw` and the editor are absent until `Edit` is activated.                                                      |
| 10  | Activate `Edit`, change the description, then cancel.                                                                  | A compact editor and Cancel/Save footer appear; Save is disabled until content changes, and Cancel restores the original Markdown.                                                |
| 11  | Inspect a Work Item containing a persisted blank To-Do row.                                                            | The blank row is not rendered. The add input appears only after `Add` / `Add a to-do item` is activated.                                                                          |
| 12  | Add a To-Do with Enter, then rapidly toggle and remove items.                                                          | Only committed, trimmed items persist; every change uses the canonical Work Item update boundary.                                                                                 |
| 13  | Inspect activity and comments.                                                                                         | Activity has one heading with its subscription action; the current-user avatar is attached to the comment composer instead of occupying a separate subscription row.              |
| 14  | Activate `Start Agent` on an idle Inbox Work Item.                                                                     | The canonical Work Item tab opens/focuses, claims the one-shot `start_agent` request, and starts through its existing orchestrator. The Inbox never mounts a second orchestrator. |
| 15  | Resize the detail from narrow to wide.                                                                                 | The thread remains a centered single reading column; compact property pills scroll horizontally instead of creating a competing right rail.                                       |
| 16  | Rapidly activate `Start Agent`, remount the Work Item panel, or request another Work Item before the first is claimed. | A claimed request starts exactly once and cannot replay; the newest unclaimed navigation intent supersedes the older one, which can never start later.                            |
| 17  | Compare the To-Do and Agent Workflow cards, then collapse Workflow.                                                    | Both cards share one Work Item thread visual shell; Workflow retains its existing collapse behavior and To-Do remains independently interactive.                                  |
| 18  | Open Assignee or Reviewer in a project-scoped Inbox Work Item.                                                         | The picker contains the complete active project roster, resolves stored member ids to names, and persists through the canonical partial-update boundary.                          |
| 19  | Inspect creator, comments, and history written with stored member ids.                                                 | Known ids resolve to project-member names; unknown ids remain visible instead of being guessed or silently blanked.                                                               |
| 20  | Load a Work Item while its project or member context read fails.                                                       | The successfully loaded Work Item remains usable under a localized warning; only failure of the required Work Item read replaces it with an error state.                          |

### Unified thread acceptance criteria

- [ ] Team Inbox uses `presentation="thread"` while ordinary Work Item surfaces retain their existing default tabs/table.
- [ ] `data-testid="work-item-thread-section"` is present and `data-testid="work-item-lower-tabs-section"` / `data-testid="work-item-linked-sessions"` are absent in Team Inbox.
- [ ] The description is read-first and enters edit mode only through `data-testid="work-item-description-edit"`.
- [ ] Blank To-Do rows are removed from the thread projection; the To-Do composer is demand-mounted.
- [ ] Properties use the shared pill fields in the thread header and no separate heavy property-card rail is rendered.
- [ ] `Open work item`, read/unread, subscription, and comment actions are grouped with their owning header/composer instead of occupying disconnected footer rows.
- [ ] Session-card navigation uses the explicit `open_session` intent and the canonical open-or-focus Session-tab atom.
- [ ] Team Inbox does not mount a second Work Item orchestrator; `Start Agent` forwards a one-shot action to the canonical Work Item tab, where lock validation, start, failure recovery, and refresh remain owned.
- [ ] The one-shot action is consumed only by its matching Work Item and is cleared before the async start begins, preventing remount/double-effect replay.
- [ ] At most one unclaimed start intent exists; a newer Work Item request explicitly supersedes the older intent instead of leaving a delayed start behind.
- [ ] The centered reading frame and metadata band are composed by `WorkItemThreadLayout`; static card shells use `WorkItemThreadSection`, while collapsible Workflow shares tokens without duplicating collapse state.
- [ ] No Session/comment transcript scan or frontend-fabricated impact data is introduced.

## Rendered product path

1. Seed or create a project member that matches the current Git identity.
2. Assign a Work Item to that member through the normal Work Item UI.
3. Click the real `Team Inbox` Sidebar row (`data-testid=sidebar-team-inbox`).
4. Verify the assigned item appears and `分配给我` keeps it visible.
5. Open its detail, mark it read, and verify the row and Sidebar unread badge update together.
6. Close and reopen Team Inbox; verify the durable local receipt remains read.
7. In a managed cloud org, use the normal Session comment member picker to mention user B.
8. In user B's independent app instance, verify `@ 提及` shows the stable comment/session target and unread badge.
9. Open the row and verify the production click persists `readAt`; list again with user B's JWT and observe `unreadCount = 0`.
10. List with user A's JWT and verify B's targeted mention is absent; refresh/reopen B's Inbox and verify it remains read.

## Degraded states

- No member identity: show an explicit identity error; do not guess from an agent/session ID.
- Signed out or local scope: skip the cloud RPC and retain local assigned items.
- Cloud mention RPC unavailable: retain local assigned items; do not scan every Session body as a fallback.
- Empty result: show the Team Inbox empty state without starting a poller.
