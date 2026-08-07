# Test Cases: Source Control main-pane keep-alive (issue #16)

Covers the keep-alive Source Control main pane introduced in `EditorMainPane`
(`SourceControlMainPane` overlay + `deriveSourceControlMainProps` /
`getGitFileForPath` in `sourceControlMainProps.ts`). The pane is mounted once the
Source Control tab has been visited, then shown/hidden instead of unmounted so
its diff view, scroll position, and lazy chunk survive navigation.

## Preconditions

- A repo is open in the WorkStation Code editor with uncommitted changes.
- The pinned `source-control` tab exists in the editor tab bar.

## Happy Path

| #   | Steps                                                                                                                  | Expected Result                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | Open Source Control tab, select a file in Focus mode, scroll the diff. Open a file tab, then return to Source Control. | Same focused diff is shown at the same scroll position; no loading flash (lazy chunk not re-imported).                    |
| 2   | Open Source Control → All Changes, scroll partway down the list. Switch to a file tab and back.                        | All Changes list is preserved at the same scroll offset.                                                                  |
| 3   | Never open Source Control during a session.                                                                            | The Source Control main pane chunk is not mounted/parsed (lazy — only mounts after first visit).                          |
| 4   | Open Source Control Focus mode without selecting a file.                                                               | A Git-branch placeholder offers View Issues, View Git history, and View PRs; each action opens the matching sidebar mode. |
| 5   | Open an empty History, Issues, or PR detail state.                                                                     | The current destination is omitted; View Source Control appears first, followed by the other destinations.                |

## Edge Cases

| #   | Scenario                   | Steps                                                                                                    | Expected Result                                                                                          |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | Empty working tree         | Open Source Control with no changes.                                                                     | Empty placeholder shown; switching away/back keeps it stable.                                            |
| 2   | Filter change while hidden | On Source Control, set filter to Staged. Switch to a file tab; stage a file via another surface; return. | Returning shows the staged-filtered list with the staged file (data stayed populated while hidden).      |
| 3   | Terminal active            | Open a terminal tab while Source Control was previously visited.                                         | Source Control overlay is hidden (pointer-events none, aria-hidden); terminal renders normally.          |
| 4   | Rapid tab switching        | Quickly toggle between a file tab and Source Control several times.                                      | No flash/remount; diff + scroll remain stable each return.                                               |
| 5   | Repo switch                | Switch repos while Source Control is the active tab.                                                     | Pane updates to the new repo's status (focus target cleared by existing `useSourceControlSetup` effect). |

## Error / Degraded States

| #   | Scenario          | Steps                                  | Expected Result                                                         |
| --- | ----------------- | -------------------------------------- | ----------------------------------------------------------------------- |
| 1   | Diff load failure | Focus a file whose diff fails to load. | Error/empty surface shown; switching away/back does not wedge the pane. |

## Accessibility

- [ ] Hidden keep-alive overlay sets `aria-hidden` and `pointer-events-none` so it is not focusable/announced when inactive.
- [ ] Active pane is keyboard-navigable (list + diff) exactly as before.
- [ ] Source Control placeholder actions are keyboard-focusable buttons with descriptive labels.

## Acceptance Criteria

- [ ] Status pipeline stays alive across navigation (already app-level; unchanged).
- [ ] Navigating away from and back to Source Control preserves the diff view, selection, and scroll without a remount flash.
- [ ] Users who never open Source Control do not pay the heavy chunk's mount cost.
- [ ] `TabContentRenderer` no longer double-renders the `source-control` case (it is a no-op; the overlay owns rendering).
- [ ] Empty Source Control detail states use Source Control navigation rather than editor/workspace actions.
- [ ] No new TypeScript errors; no new lint warnings; `deriveSourceControlMainProps` / `getGitFileForPath` unit tests pass.

## Notes / Manual QA required

- Re-render and scroll-preservation behavior is verified by manual QA in-app
  (cannot be asserted in a headless unit test). The pure derivation
  (`deriveSourceControlMainProps`, `getGitFileForPath`) is covered by
  `sourceControlMainProps.test.ts`.
