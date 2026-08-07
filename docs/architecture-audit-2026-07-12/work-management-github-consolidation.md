# Kanban GitHub consolidation architecture audit

## Acceptance criteria

- Chat Pane has no Manage Issues action, render branch, navigation command, atom, or surface reducer state.
- GitHub issue/PR ownership lives under `modules/MainApp/WorkManagement`.
- Kanban exposes distinct typed `github-issues` and `github-prs` inner sections.
- Sidebar selection, active content, and the singleton management tab resolve from the same `managementSection` value.
- Repository/options/filters remain visible in a left sub-pane while results render on the right.
- Selecting an issue or PR opens a second-level detail inside the right pane.
- Issues and PRs share one data/filter implementation but fetch only the active scope.
- TypeScript, targeted ESLint, focused tests, and whitespace checks pass.

## Ten-layer audit

| Layer                                 | Coverage                                  | Verdict | Evidence / reason                                                                                                                                                                                                                                       |
| ------------------------------------- | ----------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Compilation correctness            | TypeScript and changed-file lint          | pass    | `pnpm typecheck` and targeted ESLint complete with zero errors. Rust is untouched.                                                                                                                                                                      |
| 2. Dead code / structural duplication | Former Chat Pane Manage Issues surface    | pass    | Removed the Chat Pane lazy render, start-page and plus-menu entries, content-state branch, navigation callback, atom, surface variant, reducer field/case, and adjacent Workstation visibility checks. A global sweep finds zero old symbol references. |
| 3. Naming consistency                 | Surface and detail ownership              | pass    | The implementation is now `WorkManagement/GitHubWorkItemsSurface`; Chat-specific detail state/handlers and the Chat-specific storage key were renamed.                                                                                                  |
| 4. Semantic overloading               | `Manage Issues`, Issues, PRs, Ops section | pass    | The generic mixed Chat surface is replaced by explicit `GITHUB_ISSUES` and `GITHUB_PRS` section identities while sharing only implementation, not navigation meaning.                                                                                   |
| 5. Default branches                   | Ops content selection                     | pass    | Projects, GitHub Issues, and GitHub PRs are explicit branches; the default remains the established Ops task surface. No GitHub section silently falls through to Kanban.                                                                                |
| 6. Cross-domain leakage               | Chat Panel ↔ Kanban                       | pass    | The 2,000-line GitHub implementation moved out of `engines/ChatPanel` into the Kanban module. Shared issue detail and add-to-agent services remain imported at their existing reusable boundaries.                                                      |
| 7. New-developer clarity              | State and entry points                    | pass    | Sidebar node kinds, home-tab constants, renderer branches, and the surface `scope` prop all name Issues and PRs directly. There is one visible owner.                                                                                                   |
| 8. Wire protocol / serialization      | GitHub commands and local persistence     | pass    | Backend GitHub payloads are unchanged. Only the local repository-filter preference key changes to an Ops-owned name; no external serialized contract changes.                                                                                           |
| 9. Init parity                        | Issues and PRs entry paths                | pass    | Both sidebar entries call `openKanbanChatPanelTabAtom`, activate the singleton management tab, publish through the Ops header host, resolve repositories identically, and mount the same scoped surface.                                                |
| 10. Resolver symmetry                 | Section, query, list, detail              | pass    | The active Ops `managementSection` drives sidebar selection and main content; `scope` initializes the matching search query, filters one item kind, fetches one API family, and resets incompatible detail state on change.                             |

## Entry-point and ownership matrix

| Entry point                 | Canonical tab    | Inner section   | Data scope  | Detail host        |
| --------------------------- | ---------------- | --------------- | ----------- | ------------------ |
| Ops sidebar → GitHub Issues | singleton Kanban | `github-issues` | issues only | right results pane |
| Ops sidebar → GitHub PRs    | singleton Kanban | `github-prs`    | PRs only    | right results pane |

## Scoped-out layers

No Rust, database schema, GitHub command payload, authentication, issue mutation semantics, session dispatch, or queue lifecycle behavior changed. The existing translation strings remain reusable content labels even though the live surface owner moved to Kanban.
