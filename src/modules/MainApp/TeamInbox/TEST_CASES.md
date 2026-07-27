# Team Inbox acceptance cases

## Automated

- The Sidebar pinned menu renders Team Inbox immediately below Runtime.
- Opening Team Inbox twice focuses the same singleton Chat Panel tab.
- `all`, `mentions`, and `assigned` filters operate on one discriminated item model.
- Mixed items are deduplicated and sorted by `occurredAt`, then stable item identity.
- Local assigned Work Items require explicit current-user member IDs.
- Local cursor pagination is stable when timestamps tie and when newer rows arrive.
- Single and bulk read receipts are viewer-scoped and idempotent.
- Managed-cloud mention responses are Zod-validated and never accept a caller-supplied viewer ID.
- Raw work-item status/priority enum tokens are humanized (`humanizeToken`) when no localized key exists, and never leak to the row or detail.
- Per-filter unread counts (`countUnreadTeamInboxItemsByFilter`) de-duplicate before counting and back the filter-tab badges.
- `filterItemKind` maps `all → null`, `mentions → comment_mention`, `assigned → assigned_work_item`.
- `searchTeamInboxItems` is case-insensitive, matches title/body/summary/people, returns a fresh copy for empty queries, and empty for no match.
- `groupTeamInboxItemsByRecency` buckets by local calendar day (Today/Yesterday/This week/Earlier), omits empty groups, keeps input order, and files unparseable timestamps under "earlier".
- Assigned items carry a trimmed, whitespace-folded, 240-char body excerpt as `summary`; blank bodies omit the field (`work_item_summary_excerpt`).
- `mark_unread` deletes the viewer-scoped receipt so the item returns to unread, and is idempotent (a second call changes nothing); `removeTeamInboxCloudReadReceipts` deletes cloud receipt keys and returns the same reference when nothing changes.
- `toWireCursorItemId` preserves the backend `work_item_assigned:` source prefix (strips only the UI `assigned_work_item:` kind prefix) so `Load more` cursor pagination round-trips instead of erroring.

## Presentation / polish

1. Filter tabs (`All` / `Mentions` / `Assigned`) show a primary count badge only when that surface has unread items; badge clamps to `99+`.
2. Unread rows render a leading primary dot and bold title; read rows drop the dot and use medium weight.
3. Assigned rows show the resolved assignee **name** (not the raw member id) and a `status · priority` summary using localized labels.
4. Assigned detail shows localized `Status` and `Priority` rows and no misleading `Assigned by` row when no assigner is known.
5. `Mark all as read` in the header marks **only the active filter's** unread items (Mentions view never marks Assigned, and vice versa).
6. Empty state copy is filter-specific (`No mentions` vs `Nothing assigned to you`), falling back to the generic empty copy for `All`.
7. A `SearchInput` toolbar row filters the loaded items live; typing a non-matching query shows a dedicated `No matches` empty state (distinct from the filter-empty copy); clearing the query restores the list.
8. Rows are grouped under recency headers (`Today` / `Yesterday` / `This week` / `Earlier`); empty groups are hidden, and Arrow/Home/End keyboard navigation still traverses the flat visible order across group boundaries.
9. Selecting an assigned item lazily loads the full Work Item body and renders it as Markdown; while loading / on failure / when empty it falls back to the short list excerpt. Selecting a mention renders the comment body as Markdown. Stale body responses are discarded when the selection changes.
10. A read item's detail exposes a `Mark as unread` action; invoking it returns the row + Sidebar unread badge to the unread state (local assignment deletes the SQLite receipt; cloud mention deletes the local receipt). Re-marking read still works.
11. When a source still has a next page, the list shows a `Load more` control; invoking it appends the next page (local cursor round-trips with the `work_item_assigned:` prefix intact) and de-duplicates against the loaded set. The control hides once no source has more.

## Rendered product path

1. Seed or create a project member that matches the current Git identity.
2. Assign a Work Item to that member through the normal Work Item UI.
3. Click the real `Team Inbox` Sidebar row (`data-testid=sidebar-team-inbox`).
4. Verify the assigned item appears and `分配给我` keeps it visible.
5. Open its detail, mark it read, and verify the row and Sidebar unread badge update together.
6. Close and reopen Team Inbox; verify the durable local receipt remains read.
7. In a managed cloud org whose backend exposes `cloud_list_team_inbox_mentions`, create a comment mention through the normal Session comments UI.
8. Verify `@ 提及` shows the stable comment/session target and source navigation opens the Session.

## Degraded states

- No member identity: show an explicit identity error; do not guess from an agent/session ID.
- Signed out or local scope: skip the cloud RPC and retain local assigned items.
- Cloud mention RPC unavailable: retain local assigned items; do not scan every Session body as a fallback.
- Empty result: show the Team Inbox empty state without starting a poller.
