# Test Cases: IssuesContent

## Preconditions

- User has opened a repository with a GitHub remote (`origin` pointing to `github.com`).
- The workstation code editor sidebar is open and the Source Control tab is in "Issues" mode.
- GitHub OAuth token is stored (user is authenticated). For "no-auth" tests, no token should be stored.

---

## Happy Path

| #   | Steps                                                                       | Expected Result                                                                                                                            |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Open sidebar in Issues mode with a valid GitHub repo and authenticated user | Filter bar (Open/Closed/All) + search input + refresh button appear; issue list loads with open issues                                     |
| 2   | Click any issue row                                                         | Detail panel slides in: shows issue title, number, state icon, author, labels, body, comments, and GitHub activity in chronological order  |
| 3   | Click "←" back button in detail panel                                       | Returns to issue list; previously selected issue is no longer highlighted                                                                  |
| 4   | Click "+ New Issue" action button in the section header                     | New issue form expands above the list: title input is auto-focused                                                                         |
| 5   | Fill title + body, choose labels and assignees, click "Create"              | Issue created, form closes, new issue appears at top of list, detail panel opens for new issue                                             |
| 6   | Type in the search input                                                    | List filters in real time (≤300 ms debounce) by title, label, or author                                                                    |
| 7   | Switch filter to "Closed"                                                   | List reloads with closed issues only; filter pill updates                                                                                  |
| 8   | Switch filter to "All"                                                      | List shows both open and closed issues                                                                                                     |
| 9   | In detail panel, click "Close issue"                                        | Issue state changes to closed; if filter is "Open", issue is removed from list                                                             |
| 10  | In detail panel for a closed issue, click "Reopen issue"                    | Issue re-opens; if filter is "Closed", issue is removed from list                                                                          |
| 11  | In detail panel, type a comment and click "Comment"                         | Comment appears in the thread; comment count badge on row increments                                                                       |
| 12  | Click the globe action at the right end of the 40px detail header           | Browser opens that specific GitHub issue URL in a new tab                                                                                  |
| 13  | Click the refresh icon                                                      | Spinner appears briefly; issue list reloads from GitHub API                                                                                |
| 14  | Open an issue whose description or comment is taller than 15 lines          | The text starts as a 15-line preview with an always-visible expand control; expanding reveals the full Markdown and collapsing restores it |
| 15  | Open an issue with assignment, label, close/reopen, or milestone activity   | Each GitHub timeline event appears as a connected compact row with its actor, target/detail, and exact local date/time                     |
| 16  | Open an issue cross-referenced by another issue or pull request             | The timeline identifies the source type, number, title, and provides a link to that exact GitHub issue/PR                                  |
| 17  | Open the issue comment footer                                               | The shared textarea appears without Preview/Raw tabs; Close/Reopen and Comment use the session-creator rounded button sizing and insets    |

---

## Edge Cases

| #   | Scenario                            | Steps                                                | Expected Result                                                                           |
| --- | ----------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 1   | Empty repository (no issues)        | Open Issues panel for a new repo with zero issues    | Empty-state placeholder: "No open issues" message                                         |
| 2   | Single issue                        | Repo has exactly one issue                           | One `IssueRow` renders correctly; no truncation issues                                    |
| 3   | Issue with 20+ labels               | Open detail panel for an issue with many labels      | Labels wrap gracefully; list row shows first 4 labels with no overflow                    |
| 4   | Very long issue title               | Issue title > 200 chars                              | Title is truncated with ellipsis in list row; full title appears in detail panel (wraps)  |
| 5   | Issue with no body                  | Open detail panel for issue where `body` is `null`   | Body section is not rendered; the rest of the panel shows normally                        |
| 6   | Issue with zero comments            | Open detail panel                                    | Comment section shows empty state or nothing; "Leave a comment" input is still present    |
| 7   | Rapid filter switching              | Switch Open→Closed→All in quick succession           | Only the last request's data is displayed; no stale data bleed                            |
| 8   | Search with no matches              | Type a query that matches nothing                    | Empty-state placeholder shown in place of the list                                        |
| 9   | Submit comment with only whitespace | Type spaces in comment box and click "Comment"       | Button remains disabled; no API call made                                                 |
| 10  | Create issue with empty title       | Click "Create" without filling title                 | Submit button is disabled; form does not submit                                           |
| 11  | Repo with 100+ collaborators        | Open new issue form                                  | Only first 20 collaborators shown in the assignee list                                    |
| 12  | GitHub adds an unknown event type   | Open an issue containing that event                  | The activity remains visible with a human-readable event name rather than being discarded |
| 13  | Rapid issue switching               | Open issue A, then issue B before A finishes loading | A's late timeline response is ignored and cannot replace issue B's activity               |

---

## Error / Degraded States

| #   | Scenario                  | Steps                                    | Expected Result                                                       |
| --- | ------------------------- | ---------------------------------------- | --------------------------------------------------------------------- |
| 1   | No GitHub auth            | Open Issues panel with no stored token   | Auth placeholder shown: "Connect GitHub" title + link to Settings     |
| 2   | API fetch error           | Network is offline or GitHub returns 500 | Error state placeholder with "Failed to load issues" + "Retry" button |
| 3   | Issue close fails         | `handleCloseIssue` throws                | Issue state does not change in the list; no crash                     |
| 4   | Comment submission fails  | `handleAddComment` throws                | `submittingComment` returns to `false`; textarea retains its content  |
| 5   | Token expires mid-session | GitHub returns 401 after initial load    | `GitHubReAuthError` surfaced; auth placeholder replaces the panel     |
| 6   | Remote URL not parseable  | Repo has an exotic remote URL format     | `hasGitHubAuth` is `false`; auth placeholder shown                    |

---

## Accessibility

- [ ] Keyboard-navigable: Tab moves through filter pills → search input → refresh button → issue rows
- [ ] Issue rows are `<button>` elements (receive focus with Tab key)
- [ ] "Back" button in detail panel has a descriptive `title` attribute
- [ ] State icons (CircleDot / XCircle) have sufficient color contrast (green `#3fb950` on dark bg passes WCAG AA large text)
- [ ] Search input has a visible label/placeholder readable by screen readers
- [ ] New issue form: title input is `required` and auto-focused on open
- [ ] Submit buttons are `disabled` when invalid (not just visually hidden)
- [ ] No keyboard trap in the new issue form (Escape closes form via Cancel button)
- [ ] Long description/comment expand controls are keyboard-focusable and expose descriptive labels
- [ ] The 40px detail-header globe is a tertiary icon button labeled "Open on GitHub"
- [ ] Cmd+Enter (macOS) or Ctrl+Enter submits a non-empty issue comment from the textarea

---

## Acceptance Criteria

- [ ] Issue list loads within 2 s on a typical connection when auth is present
- [ ] Filter pills (Open/Closed/All) correctly control which issues are fetched from the API
- [ ] Search filter debounces at ≤300 ms and performs client-side filtering only (no extra API call)
- [ ] Creating an issue adds it to the top of the list (when filter is Open or All)
- [ ] Closing an issue removes it from "Open" filter view; reopening removes it from "Closed" filter view
- [ ] Adding a comment increments the issue's comment count badge in the list row
- [ ] Every long issue description and timeline comment starts collapsed at 15 lines with a visible control and can be expanded/collapsed independently
- [ ] Issue/comment timeline cards use the Settings container treatment (`bg-primary-container`, rounded border, no shadow)
- [ ] Issue detail loads GitHub's timeline endpoint, preserving comments and typed non-text activity in chronological order
- [ ] Every opener, comment, and activity row shows a timezone-aware date/time rather than only `today`/`yesterday`
- [ ] Cross-reference activity preserves and links the source issue/PR number and title
- [ ] Detail panel back button returns to the list without losing scroll position
- [ ] No TypeScript errors introduced (`pnpm typecheck` passes)
- [ ] No new ESLint warnings introduced (`pnpm lint` passes)
- [ ] `openNewIssueForm` callback is registered in `workstationIssueCallbackAtom` while the component is mounted
- [ ] Auth placeholder is shown when `hasGitHubAuth` is false
- [ ] Error placeholder includes a functional "Retry" button that re-triggers the fetch
