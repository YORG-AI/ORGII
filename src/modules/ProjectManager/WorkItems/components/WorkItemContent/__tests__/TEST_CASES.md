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

## Manual visual checks

- Compare Raw and Preview with H1-H6 headings, paragraphs, nested lists, task lists, blockquotes, inline code, fenced code, links, horizontal rules, and images in both light and dark themes.
- Confirm the editor and Preview retain identical 12px horizontal and 8px vertical content padding.
- Confirm the footer does not alter the card radius and that Cancel / Save use the standard panel-footer spacing.
