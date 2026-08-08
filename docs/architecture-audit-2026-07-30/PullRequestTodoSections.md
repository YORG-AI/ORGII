# Pull Request Todo Sections — Architecture Audit

## Acceptance checklist

- [x] PR scope loads open pull requests only.
- [x] Collapsible sections are ordered `Review requested`, `Authored by me`, then `Other todos`.
- [x] The first section contains direct outstanding review requests; the second contains viewer-authored PRs; the third contains remaining open PRs.
- [x] Merged and closed pull requests cannot enter any section.
- [x] A submitted review removes the pull request from `Review requested` using GitHub's outstanding-reviewer contract.
- [x] PR sections render in one scroll surface rather than being split across client-side pages.
- [x] Rust and TypeScript share one explicit PR-list wire shape.
- [x] Persisted PR list data is versioned so older payloads cannot be misclassified.
- [x] Work Management has one canonical managed-item/search/type implementation.
- [x] Targeted TypeScript tests, TypeScript typecheck, ESLint, Rust Clippy, and Rust serialization tests pass.

## Call-chain trace

`GitHubWorkItemsSurface` → `useGitHubWorkItemsViewState` (forces PR state to `open`) → `useGitHubWorkItemsLoadLifecycle` → `listPRsLocal` → `github_list_prs` → GitHub `/pulls` response → `parse_open_pr_item` → v2 PR cache → `mapPrToManagedItem` → `groupPullRequestsIntoTodoSections` → `GitHubWorkItemsView`.

The former `githubWorkItemsModel.ts` had no production entry-point callers after tracing. Its live consumers were migrated to the focused canonical modules and the duplicate file was deleted.

GitHub contract reference: [REST API endpoints for review requests](https://docs.github.com/en/rest/pulls/review-requests).

## Ten-layer audit

| Layer                                   | Scope inspected                                                                                       | Verdict                                                                                                                                                                 |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness              | Rust PR parser/serializer; TypeScript wire, selectors, view state, and UI                             | Pass. `tsc --noEmit`, targeted ESLint, `cargo clippy -p integrations --lib -- -D warnings`, 34 targeted Vitest assertions, and 2 Rust tests pass.                       |
| 2. Dead code and structural duplication | All imports and forward callers of `githubWorkItemsModel.ts`                                          | Fixed. Removed the 678-line parallel model after migrating its remaining live type/constant consumers.                                                                  |
| 3. Naming consistency                   | `author`, `viewerLogin`, `authoredByViewer`, `reviewRequestedFromViewer`, `requested_reviewer_logins` | Pass. Branch names are no longer mislabeled as PR authors.                                                                                                              |
| 4. Semantic overloading                 | See term table below                                                                                  | Pass after separating author identity, branch identity, and outstanding review requests.                                                                                |
| 5. Default branches                     | Missing GitHub identity fields; missing viewer credential; overlap between sections                   | Safe defaults. Unmatched open PRs enter `Other todos`; `Review requested` wins if an item also matches `Authored by me`; unknown PR search state is normalized to open. |
| 6. Cross-domain leakage                 | Tauri wire layer, shared GitHub cache, Work Management projection/UI                                  | Pass. GitHub payload parsing stays in the integration boundary; todo-section projection stays in Work Management.                                                       |
| 7. New-developer clarity                | PR parser, flags, grouping helper, cache version comment                                              | Pass. Names describe user-facing meaning and the outstanding-review behavior is documented at both wire and selector boundaries.                                        |
| 8. Wire protocol and serialization      | Actual `serde_json::to_value(OpenPRItem)` output                                                      | Pass. Tests assert `author_login`, nullable avatar, reviewer-login array, and merged-state serialization. PR cache key moved from v1 to v2.                             |
| 9. Init parity across entry points      | `listPRsLocal`, `listOpenPRsLocal`, Work Management lifecycle                                         | Pass. Both TypeScript entry points converge on `github_list_prs`; Work Management adds no alternate parser or identity initializer.                                     |
| 10. Resolver symmetry                   | Author/reviewer identity from GitHub; viewer identity from repo credential resolution                 | Pass. Both personal flags use the same case-insensitive login comparison and the same per-repository `viewerLogin`; no asymmetric fallback chain was introduced.        |

## Term overloading table

| Term                 | Canonical meaning                                                      | Previous conflict                                          | Resolution                                                                               |
| -------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `author`             | GitHub login that opened the pull request                              | Held `head_branch` in both managed-item implementations    | Now sourced from `author_login`; the branch remains `sourceBranch`.                      |
| `requested reviewer` | A reviewer with an outstanding request                                 | Could have been confused with anyone who has ever reviewed | Sourced from GitHub's current `requested_reviewers` list.                                |
| `reviewed`           | The viewer has submitted a review and is no longer currently requested | No explicit historical review scan exists                  | Leaves `Review requested`; remains eligible for `Other todos` without N per-PR requests. |
| `open`               | Pull request state exactly equal to `open`                             | Cached searches could request closed/merged PRs            | PR search normalization and grouping both enforce open-only.                             |

## Default-branch analysis

| Branch/default                            | Result                                                             | Reason                                                                   |
| ----------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Missing `user.login`                      | Not treated as authored by viewer; placed in `Other todos`         | Avoids false-positive ownership without dropping an open PR.             |
| Missing `requested_reviewers`             | Not treated as review-requested; falls through to the next section | Avoids false-positive review work.                                       |
| Missing repo credential username          | Both personal flags are false; open PR enters `Other todos`        | The UI cannot safely infer identity.                                     |
| Item matches requested and authored flags | `Review requested` only                                            | Keeps sections mutually exclusive and puts actionable review work first. |
| Cached PR query says closed/merged/all    | Normalized to `is:pr is:open`                                      | The todo surface is intentionally open-only.                             |

## Entry-point parity matrix

| Entry point                | Authenticated Tauri command | Canonical Rust parser | Canonical TS wire type | v2 cache         | Todo grouping    |
| -------------------------- | --------------------------- | --------------------- | ---------------------- | ---------------- | ---------------- |
| `listPRsLocal`             | Yes                         | Yes                   | Yes                    | Caller-dependent | Caller-dependent |
| `listOpenPRsLocal`         | Yes, through `listPRsLocal` | Yes                   | Yes                    | Caller-dependent | Caller-dependent |
| Work Management PR surface | Yes                         | Yes                   | Yes                    | Yes              | Yes              |

## Resolver fallback matrix

| Resolved field           | GitHub list payload           | Repo credential         | Missing-value behavior             |
| ------------------------ | ----------------------------- | ----------------------- | ---------------------------------- |
| PR author                | `user.login`                  | —                       | Empty; no authored match           |
| Outstanding reviewers    | `requested_reviewers[].login` | —                       | Empty; no requested match          |
| Current viewer           | —                             | Git credential username | Null; no personal match            |
| Authored/requested flags | PR identity                   | Current viewer          | Shared case-insensitive comparator |

## Systematic sweeps

- Duplicate model sweep: `rg "githubWorkItemsModel" src` → zero remaining references after deletion.
- Misidentified-author sweep: `rg "author:\\s*pr\\.head_branch" src` → zero remaining hits.
- Wire-field sweep: every `OpenPRItem` test constructor was updated or validated by full TypeScript typecheck.
- Cache compatibility sweep: PR list persistence alone needed a version bump; issue and PR-detail cache shapes are unchanged.

## Deliberate scope boundaries

- Team-level review requests are not inferred from `requested_teams`; `Review requested` represents direct outstanding requests for the authenticated viewer.
- No polling, timer, subscription, or additional per-PR network request was added.
- UI validation used static rendering plus a jsdom collapse/expand interaction test; desktop Computer Use was not authorized.
