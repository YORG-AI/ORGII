# Test Cases: PullRequestContent (Sidebar PR Summary Card)

Covers the PR header card rendered at the top of the WorkStation primary
sidebar's Pull-request view, plus its empty / create / loading / error states.
Visual-only polish task — data flow, status parsing, click-to-open, the commit
list, and the create/empty states are unchanged.

The shared GitHub timeline coverage also applies to PR descriptions,
conversation comments, submitted review bodies, and inline review threads.

## Preconditions

- A repo is open in the WorkStation Code Editor.
- The Pull-request sidebar view is selected (next to Git History).
- For the "PR exists" cases, `workstationPrAtom.prUrl` resolves to a parseable
  `https://github.com/<owner>/<repo>/pull/<n>` URL and the GitHub local API
  returns PR detail + commits.

## Happy Path

| #   | Steps                                                       | Expected Result                                                                                                                                                                                           |
| --- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Open the PR view for a branch with an **open** PR.          | Card shows a pill `● Open` (green dot + green pill), `#<number>` in muted tabular text, an `Open on GitHub` icon button on the trailing edge, a 1–2 line bold title, a branch chip, and a diff-stats row. |
| 2   | Hover the `Open on GitHub` icon button.                     | Button shows the standard header hover surface (fill background, text steps to `text-1`); cursor is a link; `title`/`aria-label` = "Open on GitHub".                                                      |
| 3   | Click the `Open on GitHub` icon button.                     | Opens `detail.htmlUrl` (falls back to `prUrl`) in a new tab (`target="_blank"`, `rel="noreferrer"`). No in-app navigation/regression.                                                                     |
| 4   | Read the stats row for additions=104, deletions=45, files=3 | Shows `+104` (green) `-45` (red) in a subtle pill, then a `FileDiff` icon + "3 files".                                                                                                                    |
| 5   | Select a commit in the list below.                          | Existing behavior unchanged — row highlights, `onHistorySelectionChange` fires with the commit selection.                                                                                                 |

## Edge Cases

| #   | Scenario                  | Steps                                                      | Expected Result                                                                                             |
| --- | ------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | Status = merged           | PR detail has `merged: true`.                              | Pill `● Merged` uses primary color (`bg-primary-1 text-primary-6`, dot `bg-primary-6`).                     |
| 2   | Status = closed           | PR `state: "closed"`, not merged.                          | Pill `● Closed` uses danger/red (`bg-danger-1 text-danger-6`).                                              |
| 3   | Status = draft            | PR `state: "draft"`.                                       | Pill `● Draft` uses warning/amber (`bg-warning-1 text-warning-6`).                                          |
| 4   | Unknown status            | PR `state: "pending_review"`.                              | Pill uses neutral fallback (`bg-fill-2 text-text-3`, dot `bg-text-3`); label = raw status, CSS-capitalized. |
| 5   | Zero stats                | additions=0, deletions=0, files=0.                         | Shows `+0 -0` and "0 files" — never blank, never `NaN`.                                                     |
| 6   | Huge stats                | additions=1234567.                                         | Renders with thousands separators: `+1,234,567`; numbers stay `tabular-nums`.                               |
| 7   | Missing numeric fields    | API omits additions/deletions/changed_files (parsed as 0). | Stats render `+0 -0`, "0 files" (helper coerces non-finite → 0).                                            |
| 8   | Very long title           | Title > 2 lines.                                           | Title clamps to 2 lines (`line-clamp-2`); full title available via `title` tooltip.                         |
| 9   | Very long branch name     | Branch name is hundreds of chars.                          | Branch chip truncates with ellipsis (CSS `truncate` for width + 80-char hard cap); full name in tooltip.    |
| 10  | Narrow sidebar width      | Drag sidebar to its minimum width.                         | Badge/number/button row stays single-line; title, branch chip, and stats wrap/truncate gracefully.          |
| 11  | No branch name            | `branchName` undefined.                                    | Branch chip is omitted; rest of the card renders normally.                                                  |
| 12  | No PR, eligible to create | `prUrl` absent, `readyToCreate` true.                      | "There is no pull request…" copy + "Create pull request" button (unchanged).                                |
| 13  | No PR, not eligible       | `prUrl` absent, `readyToCreate` false.                     | Empty `Placeholder` "No pull request" (unchanged).                                                          |

## Error / Degraded States

| #   | Scenario              | Steps                                  | Expected Result                                                                 |
| --- | --------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| 1   | Loading               | While PR detail/commits fetch.         | `Placeholder variant="loading"` in the body; header may render once detail set. |
| 2   | GitHub re-auth needed | API throws `GitHubReAuthError`.        | Body shows the "Connect a GitHub account…" message; no crash.                   |
| 3   | Generic fetch failure | API rejects with an Error.             | `Placeholder variant="error"` with the error message as subtitle.               |
| 4   | Create PR failure     | `onCreatePr` returns a non-auth error. | Inline warning alert with the error text (unchanged).                           |

## Conversation timeline

| #   | Scenario                        | Steps                                                    | Expected Result                                                                                                            |
| --- | ------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | Long PR description             | Open a PR whose description is taller than 15 lines      | Description starts as a 15-line preview with an always-visible control; expand/collapse toggles the full rendered Markdown |
| 2   | Long comment or review body     | Open Conversation with a body taller than 15 lines       | Each body truncates with a visible control and expands independently without changing adjacent timeline cards              |
| 3   | Long inline review-thread reply | Expand Review comments and open a reply over 15 lines    | Reply uses the same 15-line preview and always-visible expand/collapse control                                             |
| 4   | Conversation container styling  | Open a PR with description, comments, and review threads | Timeline and review-thread cards use the Settings container background, rounded border, and no shadow                      |

## Accessibility

- [ ] `Open on GitHub` control is a real anchor: keyboard-focusable (Tab),
      activatable with Enter, with `aria-label` + `title` = "Open on GitHub".
- [ ] Status dot is decorative (`aria-hidden`); the textual status label conveys
      state to screen readers.
- [ ] Title and branch chip expose full text via `title` when visually
      truncated.
- [ ] Color is not the only signal — each status also has a distinct text label.

## Acceptance Criteria

- [ ] All happy-path cases pass.
- [ ] Each status (open / merged / closed / draft / unknown) renders the correct
      semantic color via `getPrStatusVariant`.
- [ ] Stats use `formatStatNumber` (separators, integer truncation, NaN→0).
- [ ] Branch label uses `truncateBranchLabel` + CSS truncation + tooltip.
- [ ] `pnpm test` passes for `prCardHelpers.test.ts` with no new failures.
- [ ] No new TypeScript or lint warnings on touched files.
- [ ] Behavior/data flow (status parsing, click-to-open, commit list, create /
      empty states) is unchanged from before the polish.
- [ ] Reduced motion: card uses only color/opacity hover transitions — no
      motion-dependent affordances.
