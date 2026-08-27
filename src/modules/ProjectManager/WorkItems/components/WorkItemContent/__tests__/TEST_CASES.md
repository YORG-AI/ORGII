# Work-item description editing test cases

## Automated

- The description opens in editable Raw mode for a normal work item when an update handler is available.
- Cancel and Save remain hidden while the Markdown matches the saved description.
- Changing the Markdown reveals the shared footer with Cancel and Save actions.
- Cancel restores the saved Markdown and hides the footer.
- Save sends the Markdown draft to the update handler and hides the footer.
- GitHub-backed work-item descriptions remain rendered Markdown when no authorized GitHub interaction is available.
- Repository managers and the issue author can open the GitHub issue body in the same inline Markdown editor used by the comment composer, save it through GitHub, or cancel without changing the body.
- The GitHub body Edit control is an accessible pencil-only button; unauthorized viewers never receive the action.
- Authorized users can create a previously empty body, clear an existing body, and submit with the editor keyboard shortcut.
- A failed GitHub issue-body update keeps the editor draft mounted and shows a localized inline error.
- GitHub-backed issue descriptions use the shared 15-line collapsed preview and expand/collapse control, matching issue bodies and timeline comments.
- GitHub-backed work items load comments and activity events from the linked repository using their GitHub issue number.
- GitHub comments and non-comment events reuse the same timeline renderer as the GitHub Issues page.
- Rich Markdown Raw mode opts into the same typography and spacing contract as Preview mode.
- Timeline cards render an optional shared footer inside the card border.
- Thread Work Items default to the primary Work Item body and expose Discussion after primary content as an independent low-emphasis drill-in without a total-count badge.
- Discussion shows human comments as the primary timeline; machine-generated changes are partitioned into a default-collapsed Activity history disclosure without rewriting canonical history.
- The compact comment composer remains sticky at the bottom of Discussion and is available only when the Work Item has an update boundary.
- Empty or read-only Discussion shows a deliberate empty state without mounting a dead composer.
- Refreshing the same Work Item preserves Discussion when open; switching to a different Work Item synchronously returns to its primary body.
- The legacy default presentation keeps its expanded history behavior for callers that have not migrated to the shared thread surface.
- Team Inbox and the full "Open work item" destination both use `WorkItemThreadSurface`, including the same ordered property pills and responsive wrapping policy.
- Work Item thread descriptions use the shared 15-line measured Markdown preview and expand/collapse control used by pull-request descriptions and comments.
- Both thread entry points pass one resolved project-member identity to the comment composer and history timeline.
- Both thread entry points keep the description read-only until Edit and hide Preview/Raw tabs in the focused editor.
- Legacy one-line descriptions containing escaped Markdown line breaks render and edit with real line breaks without being persisted merely by viewing.
- A single inline `\n` in technical prose remains literal and is not treated as a legacy encoded document.
- New comments persist the current member ID, while mutation history persists the same actor ID and display name.
- Legacy history actor IDs resolve through the project member list to the member's current name, avatar, and color.
- Mutations without a trustworthy interactive actor remain system-authored instead of being attributed to the work-item creator.
- Consecutive update events from one actor within five minutes collapse into one readable summary while preserving the raw event count.
- Comments, lifecycle events, actor changes and gaps over five minutes break update groups so chronology is never merged across semantic boundaries.
- Grouped update summaries start closed and expose every original description and timestamp through the native keyboard-accessible disclosure.
- Status and priority transitions use localized product labels rather than leaking stored enum values such as `in_review`.
- Start/target date transitions render calendar dates without ISO timestamps or meaningless midnight values.
- Activity events use smart compact timestamps while preserving the full localized instant in the native time tooltip.
- To-Do history derives item-level additions, removals, completions, reopenings, starts, pending resets and renames from the persisted before/after snapshots.
- A To-Do-only burst uses an explicit checklist-action summary instead of the ambiguous generic change count plus a detached field chip.
- Malformed or reorder-only legacy To-Do snapshots fall back to the generic field update instead of rendering misleading item actions.
- Pending human handoffs render in both thread and legacy Work Item compositions from the canonical Work Item value.
- Only the resolved recipient can Accept or open the Return flow; accepted/returned status remains visible without decision actions.
- Accept invokes the actor-attributed handoff command once, updates the visible state from its result, and requests canonical refresh.

## Manual visual checks

- Compare Raw and Preview with H1-H6 headings, paragraphs, nested lists, task lists, blockquotes, inline code, fenced code, links, horizontal rules, and images in both light and dark themes.
- Confirm the editor and Preview retain identical 12px horizontal and 8px vertical content padding.
- Confirm the footer does not alter the card radius and that Cancel / Save use the standard panel-footer spacing.
- Open the same Work Item in Team Inbox and through "Open work item"; confirm both default to the Work Item body, keep Discussion outside the property band, and expose the same Discussion / Back drill-in.
- Resize each entry point from a wide window to a narrow split pane and confirm the property pills wrap without clipping or forcing horizontal scroll.
- Open Discussion, refresh the same Work Item, then select a different Work Item; confirm refresh preserves Discussion while the new item starts on the primary body.
- Add a comment as a named project member and confirm it appears in the primary Discussion timeline with the same name and avatar.
- Reopen an older work item whose history stores an internal member ID and confirm Discussion renders the member profile rather than the raw ID.
- Generate several status and priority changes within five minutes; confirm they appear only inside the default-collapsed Activity history and expand to one compact summary with at most two field chips.
- Expand a grouped change summary by mouse and keyboard; confirm every original transition remains available in chronological order, then collapse it again.
- Insert a comment between two change bursts and confirm the comment remains a full Markdown card and separates the two groups.
- Resize expanded Activity history to a narrow split pane and confirm summaries wrap without horizontal scrolling or clipping their disclosure control.
- Change a target date, expand its Activity group, and confirm the transition reads as two calendar dates while today's event timestamp shows only the local clock.
- Open a historical Work Item with persisted To-Do mutations, then expand the Activity group and confirm each row names the affected item instead of repeating "updated to-dos".
- Open a pending handoff in Team Inbox and through "Open work item"; confirm the same sender, note and actions appear in both places.
- Accept from one entry point and confirm the other shows Accepted after refresh. Create another handoff, Return it with a reason, and confirm it disappears from the recipient Inbox and returns unread to the sender.

## Entry-point lifecycle matrix

| Transition                            | Expected state                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team Inbox row → detail               | Shared thread surface mounts; opening the row marks its receipt read without mutating Work Item content.                                           |
| Team Inbox detail → Open work item    | Formal tab mounts the same thread composition from canonical Work Item data; no second property rail or legacy tabs appear.                        |
| Work Item → Discussion                | Description and workflow leave the reading pane; comments, subscription and composer replace them without mutating the Work Item.                  |
| Discussion → Work Item                | Back restores the primary task surface with its existing drafts and canonical Work Item state intact.                                              |
| Same-item refresh                     | Discussion remains open while canonical content updates; comments and Activity history re-partition from one refreshed timeline.                   |
| Different-item selection              | The view synchronously resets to the primary Work Item body; Discussion from the prior item never flashes under the new item.                      |
| Property / description update         | Canonical partial update completes, then both mounted projections reconcile through the existing data-change path.                                 |
| Start Agent from Inbox                | Navigation carries one pending `start_agent` intent; the formal page consumes it once and the canonical orchestrator owns subsequent state.        |
| Start Agent from formal page          | The already-mounted canonical orchestrator starts directly; loading/lock state remains in the shared workflow section.                             |
| Open linked Session                   | The formal page keeps its session overlay/navigation behavior; closing the Session returns to the unchanged thread.                                |
| Refresh or remote update              | `refreshSelectedWorkItem` replaces the open item atomically; the shared surface rerenders metadata, content and workflow from one Work Item value. |
| Pending handoff → Accept              | Canonical handoff becomes `accepted`; assignee remains the recipient; both Work Item entry points converge after refresh.                          |
| Pending handoff → Return              | Handoff becomes `returned`, the reason is retained, assignment returns to the sender, and prior assignment receipts are cleared atomically.        |
| Work Item or project deleted remotely | Refresh closes the owning tab; an editable ghost thread is not retained.                                                                           |
| Repeated local/remote mutations       | Canonical history remains append-only; the renderer derives compact five-minute groups without rewriting, dropping or reordering stored events.    |
| Comment during a mutation burst       | The comment remains a standalone Markdown card and closes the current mutation group; later updates begin a new group.                             |
| Expand/collapse a mutation group      | Native disclosure changes presentation state only; all raw descriptions and timestamps remain mounted from canonical timeline entries.             |
