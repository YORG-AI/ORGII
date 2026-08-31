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
- With a Cloud Org active, pull requests are loaded only from repositories in that Org's persisted synced-repository scopes; another Org's scopes are ignored and an active Org with no scopes starts no PR repository loads.
- Project-scoped assigned Work Items carry the first repository from the owning project's persisted synced-repository scope through the Rust/TypeScript wire boundary; projectless Work Items omit it.

## Presentation / polish

1. Filter tabs (`All` / `Mentions` / `Assigned`) show a primary count badge only when that surface has unread items; badge clamps to `99+`.
2. Unread rows render a leading primary dot and bold title; read rows drop the dot and use medium weight.
3. Assigned Work Item rows show one title line and a localized assignment/handoff metadata line with the compact synced-repository source (`Assigned to me · ORG2 issue`); the project slug, body excerpts, Markdown syntax, escaped newlines, and redundant assignee names do not appear in the row.
4. Successful edits in the selected Work Item immediately update the matching list row's title and assignment state; reassigning away from the viewer removes the stale assigned row.
5. Mention previews and detail Markdown bodies retain the `text-text-1` content token; assignment/repository metadata uses `text-text-2`.
6. Assigned detail shows localized `Status` and `Priority` rows and no misleading `Assigned by` row when no assigner is known.
7. `Mark all as read` in the header marks **only the active filter's** unread items (Mentions view never marks Assigned, and vice versa).
8. Empty state copy is filter-specific (`No mentions` vs `Nothing assigned to you`), falling back to the generic empty copy for `All`.
9. A `SearchInput` toolbar row filters the loaded items live; typing a non-matching query shows a dedicated `No matches` empty state (distinct from the filter-empty copy); clearing the query restores the list.
10. In the `All` filter, mentions and assigned Work Items render under their localized source headers after the actionable PR sections, without date-based subgroups; Arrow/Home/End keyboard navigation follows that visible section order. The dedicated `Mentions` and `Assigned` filters keep a flat list because the active filter already names the source.
11. Selecting an assigned item lazily loads the full Work Item body and renders it as Markdown; while loading / on failure / when empty it falls back to the stored summary even though that summary is not duplicated in the list row. Selecting a mention renders the comment body as Markdown. Stale body responses are discarded when the selection changes.
12. A read item's detail exposes a `Mark as unread` action; invoking it returns the row + Sidebar unread badge to the unread state (local assignment deletes the SQLite receipt; cloud mention deletes the managed-cloud receipt). Re-marking read still works after refresh or on another device.
13. When a source still has a next page, the list shows a `Load more` control—even when the active filter/search has no visible first-page result; invoking it appends the next page (local cursor round-trips with the `work_item_assigned:` prefix intact) and de-duplicates against the loaded set. The control hides once no source has more.
14. Activating Retry after an initial load error calls the backing source's refresh boundary before reading a new snapshot; it never loops on the same failed cache entry.
15. Partial-source degradation uses a warning treatment and preserves readable results; a total failure uses the blocking error state.
16. Pull requests and Work Items use the same Team Inbox list-row primitive, including selected/hover tokens and shared title, metadata, and optional preview overflow rules; PR-specific status icons and Work Item-specific icons remain semantic variations inside that shared shell.
17. Pull request rows show the author's avatar followed by `#number · repository · source branch` when GitHub supplies a working image URL; the author login is not repeated, and a missing or failed image is omitted without a broken-image placeholder or layout-only avatar layer.
18. The resizable Team Inbox list pane defaults to 360px and may expand to 480px, leaving enough room for PR branch and repository context while preserving a usable detail pane.
19. Row timestamps use the shared compact units (`5m`, `5h`, `3d`, `1mo`, `1y`) with no trailing `ago` and use `text-text-3`; row metadata remains `text-text-2`.
20. Top-level section headers follow the sidebar Session hierarchy with a denser treatment: 28px headers, uppercase 10px `text-text-2` labels, hover/focus disclosure chevrons, and 8px gaps between sections.
21. Repository/source labels use only the final path segment (never `owner/repository`), strip URL/query/`.git` decoration, and are capped at the first 10 characters for both pull requests and Work Items. A projectless Work Item falls back to the localized `Issue` type without inventing a repository.

## Assignment notification lifecycle

### Preconditions

- Two users resolve to distinct active member identities in the same project or Cloud Org.
- Team Inbox notifications are enabled; native delivery additionally requires OS permission.
- The recipient application is running so its push-driven Team Inbox coordinator can observe the assignment.

### Happy Path

| #   | Steps                                                                 | Expected Result                                                                                                                                                            |
| --- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | User A assigns a Work Item to user B.                                 | B receives one right-bottom in-app toast naming A and the Work Item, plus the configured native notification/sound and updated Sidebar/Dock unread badges.                 |
| 2   | B activates `View` in the toast.                                      | The singleton Team Inbox tab opens or focuses, clears an obstructing filter/search, selects only that assignment, and marks it read through the existing receipt boundary. |
| 3   | B activates the native notification while ORGII is running.           | The app window shows/focuses and the same Team Inbox target is selected; no parallel navigation path is created.                                                           |
| 4   | B opens Team Inbox manually without activating a notification or row. | No unread assignment is implicitly selected or marked read.                                                                                                                |

### Edge Cases

| #   | Scenario               | Steps                                                         | Expected Result                                                                                                                        |
| --- | ---------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Historical unread rows | Start ORGII with existing unread assignments.                 | Rows and badges hydrate, but no toast/native notification is replayed.                                                                 |
| 2   | Batched assignments    | Two new assignments arrive in one cache revision.             | One aggregate notification and toast open Team Inbox without pretending one row is the unique target.                                  |
| 3   | Duplicate/remount      | Re-emit the same item or remount the notification host.       | The store-scoped tracker suppresses duplicate delivery.                                                                                |
| 4   | Disabled category      | Disable Team Inbox notifications, then receive an assignment. | The Inbox row remains authoritative, but no toast, native notification, or sound is produced and the configured Dock badge is cleared. |
| 5   | Long names/titles      | Assign an item with a long sender name or body.               | Existing toast wrapping applies and the native body is whitespace-folded and capped at 180 characters.                                 |

### Error / Degraded States

| #   | Scenario                       | Steps                                                                | Expected Result                                                                                                                                                      |
| --- | ------------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Native permission/send failure | Receive an assignment while OS notification delivery is unavailable. | The in-app toast, Inbox row, and Sidebar badge remain usable; failure is logged without rolling back domain state.                                                   |
| 2   | Native action-listener failure | Listener registration rejects.                                       | Assignment delivery continues; the in-app `View` action remains available.                                                                                           |
| 3   | App fully exited               | Assign while the recipient process is not running.                   | The assignment hydrates as unread on next launch without a fabricated late popup; realtime closed-app delivery remains a server-push/background-runtime requirement. |

### Accessibility

- [ ] Toast `View` is a native keyboard-focusable button with a visible localized label.
- [ ] The close button retains its accessible name and does not trigger navigation.
- [ ] Notification-driven selection lands on the existing Inbox detail without creating a second modal/focus trap.

### Acceptance Criteria

- [ ] Ordinary assignment notifications identify the assigning user.
- [ ] Toast and native activation converge on one Team Inbox focus request.
- [ ] Manual Inbox opening never marks the first unread row by default.
- [ ] Only fresh unread arrivals notify; historical, duplicate, read, and unrelated native actions do not.
- [ ] Listener lifecycle is single-owner and disposed on unmount.

## Session → Work Item drop

| #   | Steps                                                                                                                        | Expected result                                                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Drag a Session tab over Team Inbox, then leave without dropping.                                                             | A localized dashed Drop Zone appears only during the eligible drag, highlights on entry, and disappears on leave/cancel without mutating data.                   |
| 2   | Drop an unlinked Session on Team Inbox.                                                                                      | A review composer opens with the parsed title, request/impact preview, authoritative destination roster, self selected by default, and an optional handoff note. |
| 3   | Keep self selected and submit.                                                                                               | One normal assigned Work Item is created with the Session snapshot and no handoff state.                                                                         |
| 4   | Select an active teammate and submit.                                                                                        | The Work Item, teammate assignment, Session provenance, creator, and `pending` handoff record are persisted in one initial write.                                |
| 5   | Drop the same Session again.                                                                                                 | The existing linked Work Item is reused; no duplicate Work Item or second handoff is created.                                                                    |
| 6   | Remove the selected teammate before submission.                                                                              | Submission revalidates the authoritative destination roster and fails visibly instead of assigning to a stale member.                                            |
| 7   | Fail the reverse Session link after the Work Item write, then Retry.                                                         | The retry finds the Work Item by `linked_sessions`, repairs the reverse link, and reports success without creating a second Work Item.                           |
| 8   | Fail the Work Item write.                                                                                                    | The configured title, recipient and note remain in the composer so the same atomic submission can be retried or cancelled.                                       |
| 9   | Complete creation and activate Open.                                                                                         | The canonical Work Item navigation opens the created/reused item; Team Inbox refreshes through its coordinator invalidation.                                     |
| 10  | Switch scope or unmount Team Inbox while preparation/write is pending.                                                       | The request is aborted best-effort and late completion cannot overwrite the current UI.                                                                          |
| 11  | Open Team Inbox without an exactly resolved viewer member identity.                                                          | Session drop creation is unavailable; no unassigned Work Item is silently created.                                                                               |
| 12  | Select another member id that resolves to the current user.                                                                  | The operation remains a self-assignment and does not create a misleading human-to-human handoff.                                                                 |
| 13  | Without an active Cloud Org, open a standalone Session that belongs to no project and has two eligible shared projects.      | The composer requires an explicit destination project, then limits sender/recipient identities to that project's roster.                                         |
| 14  | Right-click a Session tab and choose `Create team Work Item…`.                                                               | Team Inbox opens/focuses and displays the same review composer used by drag-and-drop; the Session tab remains in place.                                          |
| 15  | Remove the selected destination or recipient after the composer opens.                                                       | Submit re-reads the current roster and fails visibly without writing into another scope or retaining a stale recipient.                                          |
| 16  | Address the handoff to a second member id owned by the same signed-in person.                                                | That person can Accept/Return using the exact addressed member id; the UI does not reject a valid alias.                                                         |
| 17  | Sign in to two instances as `1106510024` and `ahanafish`, join both to the selected Cloud Org, then start a Session handoff. | The composer defaults to `1106510024 (me)`, offers active Cloud Org member `ahanafish`, and never substitutes a local project/Git alias.                         |
| 18  | Assign the Session-derived Work Item to `ahanafish` in the selected Cloud Org.                                               | One standalone cloud Work Item is written under that Cloud Org; instance 2 sees it in Assigned and can update it without a local project.                        |
| 19  | Switch accounts or Cloud Orgs while a member roster request is pending.                                                      | A late response cannot expose the previous identity/org roster or overwrite the current selection.                                                               |
| 20  | With no Cloud Org selected, repeat the handoff from a local project Session.                                                 | The existing project-scoped flow remains available and uses only that local project's roster and storage path.                                                   |
| 21  | In the handoff composer, change Status, Priority, and Due date, then compare the resulting Work Item detail.                 | Creation and detail use the same shared Work Item property pills, labels, icons, quick-date behavior, and canonical enum/date mapping.                           |

### Session-drop acceptance criteria

- [ ] Dragging is copy semantics: the source Session tab is never moved or closed.
- [ ] `pointermove` is subscribed only for an active eligible drag, hit-tests at most once per animation frame, and updates React state only when the over-boundary changes.
- [ ] The Work Item and its `linked_sessions` provenance are written together before the Session reverse link is attempted.
- [ ] The composer defaults to self, requires an available recipient, and never turns another current-user alias into a team handoff.
- [ ] Status, priority, and due date in the composer reuse `WorkItemProperties`; recipient selection remains handoff-specific so only the authoritative destination roster is assignable.
- [ ] In a Cloud Org scope, the exact cloud account id and active Cloud Org roster are authoritative for sender/recipient identity; local project/Git aliases are never substituted.
- [ ] A Cloud Org handoff writes a standalone Work Item into the active Cloud Org so the recipient can read and update it on another instance.
- [ ] Without an active Cloud Org, a standalone Session requires an explicit project when more than one eligible project exists; changing project resets the recipient to a valid project-local identity.
- [ ] Drag and the Session context-menu action converge on one request atom, one review composer, and one idempotent creation command.
- [ ] A teammate handoff persists `pending / accepted / returned`, sender/recipient identities, timestamps, and bounded notes in canonical Work Item extras.
- [ ] Creation is single-flight per viewer scope and Session, and retry after a partial link failure is idempotent.
- [ ] Session parsing is deterministic and bounded: title 120 chars, request 4,000 chars, eight touched files, and twenty explicit Markdown checkbox to-dos.
- [ ] The Drop Zone uses localized copy, design-system `Button`, semantic status/alert roles, and no raw color values.
- [ ] A project-scoped Session whose project no longer exists fails visibly instead of silently creating a standalone Work Item.
- [ ] Automated coverage exercises mapping, atomic provenance, teammate/self selection, alias handling, duplicate reuse, reverse-link repair, progress/success/open, and error/retry.

## Human handoff state machine

| State    | Owner / visible action                                                                     | Durable transition                                                                                        |
| -------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Pending  | Recipient sees `Accept` and `Return`; sender sees status when opening the linked Work Item | Accept or Return only; opening/marking read does not accept.                                              |
| Accepted | Both Work Item entry points show the accepted status                                       | Assignment stays with the recipient; retrying Accept is idempotent; Return is no longer allowed.          |
| Returned | Sender sees the item reassigned and unread; return reason remains visible                  | Handoff and reassignment commit in one SQLite transaction; the recipient's prior read receipt is cleared. |

### Handoff acceptance criteria

- [ ] Pending handoffs are distinguishable from ordinary assignments in the compact Inbox row.
- [ ] Only the resolved recipient sees decision actions; other viewers can read the status but cannot act.
- [ ] If the signed-in identity cannot be resolved, a targeted pending handoff explains why actions are unavailable instead of silently hiding them.
- [ ] Return requires a non-blank reason of at most 500 characters.
- [ ] The shared Work Item content renders the same handoff notice in Team Inbox and the formal Work Item destination.
- [ ] Accept/Return uses one actor-attributed backend command; validation, history, extras persistence, receipt reset, and collab outbox emission share the atomic Work Item boundary.
- [ ] After Accept, the left row updates from the refreshed Work Item; after Return, reassignment removes it from the recipient and makes it unread for the sender.
- [ ] Collaboration apply updates `handoff` on an existing remote Work Item, so Accept/Return reaches another device and triggers the normal project/Inbox invalidation path.

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
| 4   | Inspect a Work Item with proof of work and comments/history.                                                           | The primary body contains task execution content; Discussion is a drill-in where comments lead and system history stays collapsed.                                                |
| 5   | Switch assigned rows while the first full Work Item is still loading.                                                  | A late response from the first row never replaces the newly selected Work Item.                                                                                                   |
| 6   | Make two property changes in quick succession.                                                                         | Same-item writes run in invocation order through a bounded queue, so the final response contains both atomic partial updates and an older response cannot overwrite newer intent. |
| 7   | Open a standalone assigned Work Item received through a Cloud Org handoff.                                             | The shared property controls, comments, member picker, and handoff actions are available; every mutation uses the org-scoped atomic partial-update boundary.                       |
| 8   | Fail the selected Work Item read.                                                                                      | A visible error placeholder is shown; the short list row remains available for retry/navigation.                                                                                  |
| 9   | Open a project Work Item with a short description.                                                                     | The description renders at its natural Markdown height. `Preview / Raw` and the editor are absent until `Edit` is activated.                                                      |
| 10  | Activate `Edit`, change the description, then cancel.                                                                  | A compact editor and Cancel/Save footer appear; Save is disabled until content changes, and Cancel restores the original Markdown.                                                |
| 13  | Open Discussion and inspect comments.                                                                                  | Discussion replaces the Work Item body, prioritizes comments, keeps Activity history collapsed, and owns subscription plus the sticky current-user composer.                      |
| 14  | Activate `Start Agent` on an idle Inbox Work Item.                                                                     | The canonical Work Item tab opens/focuses, claims the one-shot `start_agent` request, and starts through its existing orchestrator. The Inbox never mounts a second orchestrator. |
| 15  | Resize the detail from narrow to wide.                                                                                 | The thread remains a centered single reading column; compact property pills scroll horizontally instead of creating a competing right rail.                                       |
| 16  | Rapidly activate `Start Agent`, remount the Work Item panel, or request another Work Item before the first is claimed. | A claimed request starts exactly once and cannot replay; the newest unclaimed navigation intent supersedes the older one, which can never start later.                            |
| 18  | Open Assignee or Reviewer in a project-scoped Inbox Work Item.                                                         | The picker contains the complete active project roster, resolves stored member ids to names, and persists through the canonical partial-update boundary.                          |
| 19  | Inspect creator, comments, and history written with stored member ids.                                                 | Known ids resolve to project-member names; unknown ids remain visible instead of being guessed or silently blanked.                                                               |
| 20  | Load a Work Item while its project or member context read fails.                                                       | The successfully loaded Work Item remains usable under a localized warning; only failure of the required Work Item read replaces it with an error state.                          |

### Unified thread acceptance criteria

- [ ] Team Inbox uses `presentation="thread"` while ordinary Work Item surfaces retain their existing default tabs/table.
- [ ] `data-testid="work-item-thread-section"` is present and `data-testid="work-item-lower-tabs-section"` / `data-testid="work-item-linked-sessions"` are absent in Team Inbox.
- [ ] The description is read-first and enters edit mode only through `data-testid="work-item-description-edit"`.
- [ ] No editable To-Do section is rendered in the Work Item thread.
- [ ] Properties use the shared pill fields in the thread header and no separate heavy property-card rail is rendered.
- [ ] `Open work item`, read/unread, subscription, and comment actions are grouped with their owning header/composer instead of occupying disconnected footer rows.
- [ ] Team Inbox and the formal Work Item both default to the Work Item body, place Discussion after primary content, and keep it outside the property metadata band.
- [ ] Session-card navigation uses the explicit `open_session` intent and the canonical open-or-focus Session-tab atom.
- [ ] Team Inbox does not mount a second Work Item orchestrator; `Start Agent` forwards a one-shot action to the canonical Work Item tab, where lock validation, start, failure recovery, and refresh remain owned.
- [ ] The one-shot action is consumed only by its matching Work Item and is cleared before the async start begins, preventing remount/double-effect replay.
- [ ] At most one unclaimed start intent exists; a newer Work Item request explicitly supersedes the older intent instead of leaving a delayed start behind.
- [ ] The centered reading frame and metadata band are composed by `WorkItemThreadLayout`; static card shells use `WorkItemThreadSection`, while collapsible Workflow shares tokens without duplicating collapse state.
- [ ] No Session/comment transcript scan or frontend-fabricated impact data is introduced.

## Core multi-user collaboration closure

| #   | Steps                                                                                                                   | Expected result                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | In instance A, create a Session-derived Work Item for B and choose status, priority, and target date before submitting. | The initial standalone Work Item persists all selected properties together with Session provenance, assignee, and pending handoff state.                     |
| 2   | Open the new assignment in instance B.                                                                                  | B sees the same property strip as A, including status, priority, assignee, reviewer, and target date; the pending handoff notice exposes Accept and Return.  |
| 3   | In B, change status, priority, and target date in quick succession.                                                     | Writes are serialized as atomic partial updates; A receives the final merged values through Cloud Org sync without reopening the Work Item.                  |
| 5   | In B, add a comment and select A with the `@` member control.                                                           | The comment stores A's stable Cloud Org user id; A receives an unread Work Item comment mention in `Mentions`, and opening/marking it read is viewer-scoped. |
| 6   | In B, reassign the Work Item to A.                                                                                      | The assignment receipt is reset in the same transaction; the row leaves B's Assigned view and appears unread in A's Assigned view.                           |
| 7   | Create another A → B handoff, then have B accept it.                                                                    | The handoff becomes accepted while assignment remains with B; retrying the same transition is idempotent.                                                    |
| 8   | Create another A → B handoff, then have B return it with a reason.                                                      | Handoff state, reason, history, reassignment to A, receipt reset, and one collaboration outbox write commit atomically.                                      |
| 9   | In instance B, drop one of B's Sessions into Team Inbox and assign it to A.                                             | The same composer and state machine produce a reverse B → A handoff; no direction-specific UI or backend branch is required.                                 |
| 10  | Remove a member from the active Cloud Org after the composer opens, then submit.                                        | Submission revalidates the authoritative roster and fails visibly; no stale recipient or cross-org assignment is persisted.                                  |
| 11  | Keep a standalone Work Item selected in A while B edits it.                                                             | The selected detail demand-reloads when the coordinator observes a newer `updatedAt`; no timer or detail poller is created.                                  |
| 12  | Sign out, switch account, or switch Cloud Org while roster/detail requests are in flight.                               | Late results are discarded and never expose or persist data from the previous identity or organization.                                                      |

### Core collaboration acceptance criteria

- [ ] Project-scoped and standalone Work Items reuse the same Work Item thread and property components.
- [ ] Standalone reads and writes are scoped by `orgId + shortId + project_id IS NULL`; a caller cannot update another organization's item.
- [ ] Status, priority, target date, comments, assignment, and handoff state use one atomic partial-update transaction and emit at most one collaboration write after commit.
- [ ] Rapid standalone mutations are queued in invocation order, and remote invalidation reloads only the selected Work Item after its observed revision advances.
- [ ] Reassignment clears the prior assignment episode's receipt transactionally so the new assignee receives an unread row.
- [ ] Comment mentions persist only normalized active-roster user ids; self, unknown, blank, and duplicate ids are rejected before persistence.
- [ ] Work Item comment mentions are viewer-scoped Inbox targets with durable read/unread receipts and do not appear for other members.
- [ ] Pending handoff Accept/Return is recipient-only; Return requires a bounded reason and reassigns to the original sender atomically.
- [ ] Session handoff is direction-neutral: either member can create a new Work Item for the other using the same composer and backend state machine.
- [ ] Create-from-Session persists the selected status, priority, and target date in the initial canonical Work Item rather than patching presentation state afterward.
- [ ] Cloud propagation remains push-driven through the existing Org signal and coordinator invalidation path; the feature introduces no interval, retry loop, or hidden-window poller.

## Rendered product path

1. Seed or create a project member that matches the current Git identity.
2. Assign a Work Item to that member through the normal Work Item UI.
3. Click the real `Team Inbox` Sidebar row (`data-testid=sidebar-team-inbox`).
4. Verify the assigned item appears and `分配给我` keeps it visible.
5. Open its detail, mark it read, and verify the row and Sidebar unread badge update together.
6. Close and reopen Team Inbox; verify the durable local receipt remains read.
7. In a managed Cloud Org, create a Session-derived Work Item for user B with a non-default status, priority, and target date.
8. In user B's independent app instance, verify Assigned shows the Work Item and its full property, comment, reassignment, and handoff controls.
9. In B, comment on the Work Item and select A with the `@` member control; verify A's `@ Mentions` receives the stable Work Item target and unread badge.
10. Open the mention in A and verify the production click persists `readAt`; list again as A and observe `unreadCount = 0`, while B never sees A's targeted mention.
11. Reassign the Work Item from B to A, then repeat with Return; verify both assignment projections and handoff state converge across the two instances.

## Degraded states

- No member identity: show an explicit identity error; do not guess from an agent/session ID.
- Signed out or local scope: skip the cloud RPC and retain local assigned items.
- Cloud mention RPC unavailable: retain local assigned items; do not scan every Session body as a fallback.
- Empty result: show the Team Inbox empty state without starting a poller.
