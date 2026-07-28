# Work-item description editing test cases

## Automated

- The description opens in editable Raw mode for a normal work item when an update handler is available.
- Cancel and Save remain hidden while the Markdown matches the saved description.
- Changing the Markdown reveals the shared footer with Cancel and Save actions.
- Cancel restores the saved Markdown and hides the footer.
- Save sends the Markdown draft to the update handler and hides the footer.
- GitHub-backed work-item descriptions use the rendered Markdown body rather than mounting an editor, even when an update handler is available.
- GitHub-backed issue descriptions use the shared 15-line collapsed preview and expand/collapse control, matching issue bodies and timeline comments.
- GitHub-backed work items load comments and activity events from the linked repository using their GitHub issue number.
- GitHub comments and non-comment events reuse the same timeline renderer as the GitHub Issues page.
- Rich Markdown Raw mode opts into the same typography and spacing contract as Preview mode.
- Timeline cards render an optional shared footer inside the card border.
- Thread Activity starts collapsed, keeps the subscription action available, and shows the event count in its heading.
- Expanding Activity reveals the existing timeline and compact comment composer; collapsing it hides both again.
- The legacy default presentation keeps its expanded history behavior for callers that have not migrated to the shared thread surface.
- Team Inbox and the full "Open work item" destination both use `WorkItemThreadSurface`, including the same ordered property pills and responsive wrapping policy.
- Both thread entry points pass one resolved project-member identity to the comment composer and history timeline.
- Both thread entry points keep the description read-only until Edit and hide Preview/Raw tabs in the focused editor.
- Legacy one-line descriptions containing escaped Markdown line breaks render and edit with real line breaks without being persisted merely by viewing.
- A single inline `\n` in technical prose remains literal and is not treated as a legacy encoded document.
- New comments persist the current member ID, while mutation history persists the same actor ID and display name.
- Legacy history actor IDs resolve through the project member list to the member's current name, avatar, and color.
- Mutations without a trustworthy interactive actor remain system-authored instead of being attributed to the work-item creator.

## Manual visual checks

- Compare Raw and Preview with H1-H6 headings, paragraphs, nested lists, task lists, blockquotes, inline code, fenced code, links, horizontal rules, and images in both light and dark themes.
- Confirm the editor and Preview retain identical 12px horizontal and 8px vertical content padding.
- Confirm the footer does not alter the card radius and that Cancel / Save use the standard panel-footer spacing.
- Open the same Work Item in Team Inbox and through "Open work item"; confirm the description, metadata pills, To-Do, Agent Workflow and collapsed Activity appear in the same order and use the same spacing.
- Resize each entry point from a wide window to a narrow split pane and confirm the property pills wrap without clipping or forcing horizontal scroll.
- Open two different thread-style work items and confirm each Activity section starts collapsed, then verify the chevron and keyboard activation expose the timeline without shifting the surrounding cards.
- Add a comment as a named project member, expand Activity, and confirm the submitted comment and composer show the same name and avatar.
- Reopen an older work item whose history stores an internal member ID and confirm Activity renders the member profile rather than the raw ID.

## Entry-point lifecycle matrix

| Transition                            | Expected state                                                                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Team Inbox row → detail               | Shared thread surface mounts; opening the row marks its receipt read without mutating Work Item content.                                           |
| Team Inbox detail → Open work item    | Formal tab mounts the same thread composition from canonical Work Item data; no second property rail or legacy tabs appear.                        |
| Property / description / To-Do update | Canonical partial update completes, then both mounted projections reconcile through the existing data-change path.                                 |
| Start Agent from Inbox                | Navigation carries one pending `start_agent` intent; the formal page consumes it once and the canonical orchestrator owns subsequent state.        |
| Start Agent from formal page          | The already-mounted canonical orchestrator starts directly; loading/lock state remains in the shared workflow section.                             |
| Open linked Session                   | The formal page keeps its session overlay/navigation behavior; closing the Session returns to the unchanged thread.                                |
| Refresh or remote update              | `refreshSelectedWorkItem` replaces the open item atomically; the shared surface rerenders metadata, content and workflow from one Work Item value. |
| Work Item or project deleted remotely | Refresh closes the owning tab; an editable ghost thread is not retained.                                                                           |
