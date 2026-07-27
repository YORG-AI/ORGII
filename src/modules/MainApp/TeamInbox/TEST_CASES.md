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
10. A read item's detail exposes a `Mark as unread` action; invoking it returns the row + Sidebar unread badge to the unread state (local assignment deletes the SQLite receipt; cloud mention deletes the managed-cloud receipt). Re-marking read still works after refresh or on another device.
11. When a source still has a next page, the list shows a `Load more` control; invoking it appends the next page (local cursor round-trips with the `work_item_assigned:` prefix intact) and de-duplicates against the loaded set. The control hides once no source has more.

## Unified Work Item thread

| #   | Steps                                                                                                                  | Expected result                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Select a project-scoped assigned Work Item.                                                                            | The full Work Item uses the shared content and property components; the reduced Markdown/metadata preview is not rendered.                                                        |
| 2   | Inspect a Work Item with linked Sessions.                                                                              | Workflow and Session run cards appear inline in one continuous thread. The legacy `Session / Output / History` tab strip and linked-Session table are absent in Team Inbox.       |
| 3   | Activate `View live chat` / `View conversation` on a Session card.                                                     | A separate Session Chat Panel tab opens or the existing tab for that Session is focused. Team Inbox remains open as its singleton tab.                                            |
| 4   | Inspect a Work Item with proof of work and comments/history.                                                           | Output and activity render inline after the workflow; no second nested detail surface is introduced.                                                                              |
| 5   | Switch assigned rows while the first full Work Item is still loading.                                                  | A late response from the first row never replaces the newly selected Work Item.                                                                                                   |
| 6   | Make two property changes in quick succession.                                                                         | Only the newest response may replace the displayed Work Item snapshot; both writes use the canonical partial-update payload.                                                      |
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
