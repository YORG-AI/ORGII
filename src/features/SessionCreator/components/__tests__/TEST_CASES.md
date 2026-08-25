# Test Cases: Worktree source selectors + worktree launch wiring

## Session info ownership (issue #332)

| #   | Steps                                                | Expected Result                                                                                                                                |
| --- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | Open Session Creator with a Git repository selected  | Session info renders Repository → Running location → Branch; it does not add a Main checkout / Switch worktree segment                         |
| W2  | Open Session Creator while linked worktrees exist    | Linked worktrees are not listed in SessionInfoLine; global WorktreePalette remains the single place for switching the active checkout          |
| W3  | Choose New Worktree from the running-location picker | The final Branch control opens immediately as a Spotlight or anchored dropdown (matching the picker preference); no modal opens                |
| W4  | Select a different Workspace                         | Pending new-worktree source state clears and running location returns to `local`; no path or source from the previous repository leaks forward |

## Repository chrome position

| #   | Steps                                                                 | Expected Result                                                                                                                                         |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Right-click the lower repository chrome and choose **Move to top**    | Repository, branch, and running-location controls render above the composer with the established top corners and mirrored seam/outer padding            |
| C2  | Right-click the upper repository chrome and choose **Move to bottom** | The same controls render outside and below the complete composer, with matching bottom corners, the same total padding, and no input glow flashing      |
| C3  | Choose a position, close ORGII, then reopen Session Creator           | The selected position is restored from `orgii:sessionCreator:repoChromePosition`                                                                        |
| C4  | Open a layout with no saved position                                  | Launchpad keeps its existing Up default; standard Session Creator keeps its existing Down default                                                       |
| C5  | Open a compact/hidden repository-info Session Creator                 | No position control appears because there is no independently movable repository chrome                                                                 |
| C6  | Right-click the repository/branch/location chrome                     | WebKit's Back/Reload/Inspect menu is suppressed; the native OS menu offers only the applicable **Move to top** or **Move to bottom** command            |
| C7  | Choose **Hide pinned actions** in the native chrome menu              | Pinned skill, tool, built-in, and Canvas quick-action pills disappear; the `…` manager and unrelated GUI/TUI, work-item, org, and setup controls remain |
| C8  | Reopen Session Creator after hiding pinned actions                    | Pinned quick-action pills remain hidden; choosing **Show pinned actions** restores the existing pins without repinning them                             |
| C9  | Open compact/hidden repository-info creator after hiding              | Pinned quick actions remain visible because that surface has no repository chrome menu from which visibility could be restored                          |

Covers the Session Creator picker (`WorktreeSourceSelector.tsx`), the legacy
global-worktree creation modal (`WorktreeSourceModal.tsx`), and the
launch-payload wiring that turns the picked source into backend worktree fields
(`getWorktreeFields` in `useSessionLaunch/launchPayload.ts`).

## Preconditions

- A repo is selected in the SessionCreator and the running location can be set
  to `worktree`.
- For PR mode: the repo has an `origin` remote whose URL parses to a GitHub
  `owner/name`, and the local GitHub integration can list open PRs.
- For Branch mode: `repoPath` is in scope so `getGitBranches` (Rust HTTP
  `/repos/:id/branches`) can list local + remote branches. Remote branches come
  back in short-ref form (`origin/develop`) directly usable by `git worktree add`.

## Happy Path

| #   | Steps                                                    | Expected Result                                                                                                                                                               |
| --- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Open the running-location pill and choose "New Worktree" | The Branch selector opens immediately; the row remains ordered Repository → Running location → Branch and no modal appears                                                    |
| 2   | Use the left-aligned Branch / PR switch and choose PR    | PR data loads on demand into the same Spotlight/dropdown surface; branch and PR requests are not both started while Branch mode is active                                     |
| 3   | Pick a **same-repo** PR                                  | The selector stays open while `worktree_resolve_pr_base` runs; on success it closes, the Branch pill shows the PR label, and the source gains `resolvedBaseRef` = PR head SHA |
| 4   | Launch the session                                       | Payload carries `isolate: true` and `branch` = `resolvedBaseRef` (the fetched head SHA); backend creates `agent/<session>` from that SHA                                      |
| 5   | Branch mode: pick a branch from the list, then launch    | Selection commits immediately; payload `isolate: true`, `branch` = picked branch's resolvable ref (no PR resolve step)                                                        |
| 6   | Pick a **fork / cross-repo** PR                          | Resolver's branch fetch misses → falls back to `refs/pull/<n>/head`; success yields `resolvedBaseRef` = fork head SHA; launch uses that SHA                                   |

## Branch mode (grouped picker — aligned with the Spotlight "Switch Session Branch" selector)

Branch mode reuses the Spotlight selector's data + logic: `groupBranchOptions` for the
RECENT / WORKTREES / Other Branches sections, `useWorktreeMap` (`getGitWorktrees`) for the
worktree section, and `formatRelativeTime(..., "short")` for the right-aligned timestamps.
Rows are icon-first (worktree → `Folder`, remote → `Cloud`, local → `GitBranch`) with **no
text subtitle**. Pure grouping / timestamp logic is unit-tested in `worktreeBranchSource.test.ts`.

| #   | Steps                                                            | Expected Result                                                                                                                                                                                                                                |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | Open Branch mode in a repo with branches                         | Branches load into a scrollable **grouped** list: `RECENT` (current/default first), then `WORKTREES` (if any), then `Other Branches`; section headers use the shared `sectionLabel` style; current branch is marked selected                   |
| B1a | Inspect a branch row                                             | Single-line row: **left icon** by type (worktree `Folder` / remote `Cloud` / local `GitBranch`), branch name, **right-aligned relative timestamp** ("Yesterday" / "4 hr ago" / "2 days ago"); **no** "Local branch" / "Remote branch" subtitle |
| B2  | Pick a **local** branch (e.g. `main`)                            | Source commits immediately as `{ kind:"branch", baseBranch:"main", sourceRef:"branch:main" }`; launch uses `main`                                                                                                                              |
| B3  | Pick a **remote** branch (e.g. `origin/develop`)                 | `baseBranch:"origin/develop"` (short-ref form) → `git worktree add origin/develop` resolves without a bare unknown name                                                                                                                        |
| B3a | Pick a branch from the **WORKTREES** section                     | Source carries the registered `existingWorktreePath`; launch reuses that checkout instead of creating another isolated worktree                                                                                                                |
| B4  | Type `dev` in the search box                                     | List filters case-insensitively to names containing `dev`, re-grouped into the same sections; non-matching branches hidden                                                                                                                     |
| B5  | Type a ref with no exact branch match (tag / sha, e.g. `v1.2.0`) | A distinct **"Use \"v1.2.0\" as ref"** row (Hash icon + "Tag, commit, or any git ref" hint) appears at the top (above the sections); picking it yields `baseBranch:"v1.2.0"` — the custom-ref escape hatch preserved                           |
| B6  | Type a query that exactly matches an existing branch             | No custom-ref row shown (the real branch row already covers it); exact branch selectable                                                                                                                                                       |
| B7  | Delete the current search query                                  | Full grouped branch list is restored                                                                                                                                                                                                           |
| B8  | Open Branch mode in a repo with **no worktrees**                 | No `WORKTREES` section shown; only `RECENT` + `Other Branches`; no error (empty worktree map is best-effort)                                                                                                                                   |
| B9  | Branch with no commit date                                       | Row renders with no right timestamp (blank), icon + name still shown                                                                                                                                                                           |

## Legacy modal Smart tab (global WorktreePalette create action)

Covers `parseSmartInput` (classification) + `buildSmartSuggestions` (mixed list) and the
Smart-tab UI wiring. Pure logic is unit-tested in `worktreeSmartInput.test.ts`.

| #   | Scenario                        | Steps                                                | Expected Result                                                                                                                                                                                                   |
| --- | ------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Empty query                     | Open Smart tab, leave input empty                    | List shows the two preserved smart default rows (`smart:current` / `smart:repo`) first, then recent PRs (≤5) and local branches (≤6); first row preselected; confirm enabled; height stable                       |
| S2  | `#123` (or bare `123`)          | Type `#123`                                          | Classified as PR number → a resolvable PR row floats to top (enriched with title/head→base when in the fetched list, else a generic "Pull request" row still resolvable by number); a matching issue also appears |
| S3  | `owner/repo#12` matching origin | Type origin `owner/repo#12`                          | Resolvable PR row (kind `pr`, `pr:{prNumber:12}`); confirm runs `resolvePrWorktreeBase`                                                                                                                           |
| S4  | Foreign `owner/repo#12`         | Type a non-origin `owner/repo#12`                    | Non-resolvable named-worktree row (kind `name`, detail "…not resolvable here…"); confirm creates a named worktree from HEAD — no faked git base                                                                   |
| S5  | GitHub PR URL (origin)          | Paste `https://github.com/<origin>/pull/99`          | Resolvable PR row; confirm resolves via backend                                                                                                                                                                   |
| S6  | GitHub PR URL (foreign repo)    | Paste a PR URL for another repo                      | Non-resolvable named-worktree row (limitation shown in detail)                                                                                                                                                    |
| S7  | GitLab MR URL                   | Paste `https://gitlab.com/g/app/-/merge_requests/45` | Parsed to PR-like structure but kept as a non-resolvable named-worktree row (no backend base resolution for GitLab) — limitation stated, base not faked                                                           |
| S8  | Branch-like text                | Type `main` (exact branch)                           | Exact branch match floats to top (kind `branch`); no custom-ref row; a trailing `name` fallback row is always present                                                                                             |
| S9  | Non-matching ref (tag/sha)      | Type `v1.2.0`                                        | A `customRef` row ("Use \"v1.2.0\" as ref") appears plus the `name` fallback                                                                                                                                      |
| S10 | Free text (name)                | Type `my cool feature`                               | PR/branch substring matches (if any) then a `name` row (slugged `name:my-cool-feature`, base = current branch)                                                                                                    |
| S11 | Zero data + query               | No PRs/branches loaded, type `anything`              | List degrades to `[customRef, name]` — never a dead end                                                                                                                                                           |
| S12 | Loading                         | Slow PR/branch fetch, empty query                    | 180px spinner while both sources still loading and no suggestions yet; modal height stable                                                                                                                        |
| S13 | GitHub not configured           | No origin remote / GitHub unavailable                | Smart still works from branches + name + custom ref (no hard error); PR rows simply absent                                                                                                                        |
| S14 | Query edit resets selection     | Select a row, then type more                         | Selection resets; confirm target falls back to the new first suggestion                                                                                                                                           |

## Edge Cases

| #   | Scenario                                 | Steps                                                                                               | Expected Result                                                                                                                                                                                                                                                                                                                                                   |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | No base branch on source                 | Pick a source whose `baseBranch` is empty/whitespace                                                | Payload `isolate: true` with no `branch` override (isolate from HEAD / resolved session branch)                                                                                                                                                                                                                                                                   |
| 2   | Existing worktree path reused            | `selectedWorktreePath` set                                                                          | Payload `{ worktreePath }`; no `isolate`; source base branch NOT leaked into payload                                                                                                                                                                                                                                                                              |
| 3   | Non-worktree launch                      | `runningLocation="local"` while a source is set                                                     | No `isolate`/`worktreePath`/worktree branch override in payload                                                                                                                                                                                                                                                                                                   |
| 4   | GitHub tab, many PRs (30)                | Load 30 PRs                                                                                         | List scrolls internally at `max-h-[200px]`; modal does not grow unbounded                                                                                                                                                                                                                                                                                         |
| 5   | GitHub tab, empty/loading/error          | Repo with no PRs / slow / failing fetch                                                             | Fixed-height (180px) state message; modal height stable, no jump between tabs                                                                                                                                                                                                                                                                                     |
| 6   | Rapid tab switching                      | Toggle Smart/GitHub/Branch/Name repeatedly                                                          | Modal height stays ≈250px min; no large jumps                                                                                                                                                                                                                                                                                                                     |
| 6a  | List-item visual consistency across tabs | Populate each of Smart / GitHub / Branch / Name so at least one row shows, then switch between them | Every tab renders its rows inside the **same** bordered `SourceList` wrapper (border + `bg-bg-2` + `max-h` internal scroll), including the Name tab's single row; all rows share the same `min-h-[52px]` height, icon size (14px), padding, font sizes, hover + selected styling — single-line Branch rows are the same height as two-line GitHub/Smart/Name rows |
| 6b  | Confirm loading stability                | Pick a PR and click "Use worktree" while resolution is slow                                         | Primary button keeps its width and visible label, adds only the spinner, and does not shift or leave stale footer/button pixels in WebKit                                                                                                                                                                                                                         |
| 10  | Branch tab, loading                      | Slow `getGitBranches`                                                                               | Fixed-height (180px) spinner; modal height stable                                                                                                                                                                                                                                                                                                                 |
| 11  | Branch tab, no branches                  | Repo with an empty branch list                                                                      | 180px empty message ("No branches found…"); typing a ref still surfaces the custom-ref row so confirm works                                                                                                                                                                                                                                                       |
| 12  | Branch tab, no remote                    | Repo with only local branches                                                                       | Only local-icon (`GitBranch`) rows shown; no remote (`Cloud`) rows; no error; no text subtitle                                                                                                                                                                                                                                                                    |
| 13  | Branch tab, no matches                   | Search that matches no branch AND equals no ref intent                                              | If query non-empty → custom-ref row shows; only when query is empty-after-filter with 0 options does the "No matching branches" message show                                                                                                                                                                                                                      |
| 7   | Whitespace base branch                   | Source `baseBranch: "  main  "`                                                                     | Payload `branch: "main"` (trimmed)                                                                                                                                                                                                                                                                                                                                |
| 8   | `resolvedBaseRef` precedence             | Source has both `resolvedBaseRef` (SHA) and `baseBranch`                                            | Payload `branch` = `resolvedBaseRef` (SHA wins over label branch)                                                                                                                                                                                                                                                                                                 |
| 9   | Issue source picked                      | Pick an `issue:<n>` row, confirm                                                                    | No resolve call (issue is not a PR); source launches unchanged — issue cannot resolve to a git base                                                                                                                                                                                                                                                               |

## Error / Degraded States

| #   | Scenario                  | Steps                                                                                               | Expected Result                                                                                                                    |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | GitHub fetch fails        | Both PR + issue fetches reject                                                                      | Error message shown in list; modal usable via other tabs                                                                           |
| 2   | PR resolve fails          | `worktree_resolve_pr_base` rejects (auth/network, or neither branch nor `refs/pull` fetch succeeds) | Inline error `<span>` in footer (`text-danger-6`); modal stays open; **no** synthetic `pr:<n>` id leaks to launch; spinner cleared |
| 3   | Repo path missing         | PR selected but no `repoPath` in scope                                                              | Resolve step skipped; source launches with its label branch (best-effort, unchanged)                                               |
| 4   | Branch fetch fails        | `getGitBranches` rejects (server down)                                                              | `role="alert"` 180px error message; a typed custom ref is still offered so the tab stays usable                                    |
| 5   | Branch tab, no `repoPath` | Branch tab opened without a repo path                                                               | Fetch skipped → empty state; custom-ref entry remains the only path (typed ref)                                                    |

## Accessibility

- [x] Branch / PR segmented control exposes an accessible group label and pressed state
- [x] Spotlight and dropdown variants use the shared keyboard-navigation engines; Enter selects and Escape closes
- [x] Search inputs have explicit accessible labels; fetch/resolve failures use live alert semantics

## Acceptance Criteria

- [x] A picked **same-repo PR** resolves to its head SHA (`worktree_resolve_pr_base` branch fetch) and that SHA drives worktree creation
- [x] Session Creator renders Repository → Running location → Branch and opens no modal when New Worktree is chosen
- [x] The worktree Branch selector follows the configured Spotlight/dropdown presentation and uses the agent-picker pattern: a left-aligned segmented pill for Branch / PR
- [x] Branch data loads first; GitHub PR I/O begins only after PR mode is selected; both retain the existing bounded repo-scoped caches and in-flight dedupe
- [x] Worktree source selection does not mutate or checkout the local session branch; switching back to This Mac restores the local branch context unchanged
- [x] A picked **fork / cross-repo PR** resolves via `refs/pull/<n>/head` fallback and its head SHA drives worktree creation
- [x] `resolvedBaseRef` (SHA) takes precedence over the label `baseBranch` in the launch payload `branch`
- [x] Resolve failures surface an inline error and never silently launch on a synthetic id
- [x] Issue sources launch unchanged (no fake git base)
- [x] `worktreePath` reuse branch preserved and unaffected by source metadata
- [x] Non-worktree launches carry no worktree fields
- [x] GitHub list has a bounded max-height with internal scroll; modal height stable across tabs
- [x] Smart tab is a **unified smart input**: `parseSmartInput` classifies empty / `#123` / `owner/repo#123` / GitHub·GitLab PR·MR URL / branch·ref / free text, and `buildSmartSuggestions` returns a mixed, de-duplicated list (exact matches first, always a trailing `name` fallback)
- [x] Origin PR references (`#n`, matching `owner/repo#n` / GitHub PR URL) are resolvable via `resolvePrWorktreeBase`; cross-repo / foreign / **GitLab MR** references are parsed but kept as honest named-worktree suggestions with no faked git base
- [x] Branch tab lists **real** local + remote branches (`getGitBranches`) instead of accepting any free-text string; a non-existent name is no longer silently confirmable as a branch row
- [x] Branch tab is **aligned with the Spotlight "Switch Session Branch" selector**: `RECENT` / `WORKTREES` / `Other Branches` sections (`categorizeBranches`), icon-differentiated rows (worktree / remote / local — **no** "Local branch" / "Remote branch" text subtitle), and right-aligned relative timestamps (`formatRelativeTime` "short")
- [x] Worktree grouping reuses `useWorktreeMap` (`getGitWorktrees`); a worktree-section row still produces a plain `{ kind:"branch", baseBranch:<branch ref> }` source
- [x] Remote branches use the resolvable short-ref form (`origin/develop`) so `git worktree add` succeeds
- [x] Custom-ref escape hatch preserved: a non-matching search term is offered as a visually distinct "Use \"…\" as ref" row (tag / commit / any ref)
- [x] Branch tab shows loading / empty / error / no-match states at a fixed 180px height under the `max-h` cap — modal height stays stable
- [x] **All four tabs render list items identically**: every tab wraps its rows in the shared `SourceList` container (Name tab's single row included — no longer bare), and every `SourceRow` uses the same `min-h-[52px]` so single-line (Branch) rows match two-line (GitHub / Smart / Name) rows — structure, container, and row height are consistent cross-tab
- [x] `pnpm test` (launchPayload + worktreeSourceResolve + worktreeBranchSource), `pnpm typecheck`, `cargo test -p git pr_base`, `cargo check` pass

## Resolved this PR (was: Known Limitation)

Previously the backend had no way to turn a PR number into a git base, so only a
locally-resolvable head branch worked. This PR adds
`git::pr_base::worktree_resolve_pr_base`, which fetches the PR head (branch, then
`refs/pull/<n>/head` fallback) and rev-parses it to a concrete SHA. The SHA is
stored as `WorktreeLaunchSource.resolvedBaseRef` and fed to
`create_session_worktree` via the existing `branch` field — so same-repo **and**
fork/cross-repo PRs now genuinely drive isolated worktree creation. Issues remain
display-only: an issue number has no git head to resolve.
