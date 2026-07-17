# Test Cases: Spotlight branch switching via guarded checkout (Issue #17)

Routes Spotlight branch operations through the canonical guarded checkout
(`useRepoSelection().selectBranch` → `useBranchCheckout.selectBranch`) so a dirty
working tree surfaces the `CheckoutConflictDialog` (stash / discard / cancel).

> Pure logic covered by Vitest: the `uncommitted_changes` classifier for the
> `checkout` operation lives in
> `src/util/dialogs/__tests__/gitErrorDialogHelpers.test.ts`. The handler
> orchestration below is integration-level (modal + git API) and is verified
> manually / by the agent harness — the repo's UI-feature workflow forbids
> `.tsx` / testing-library tests.

## Preconditions

- A git repo is selected in Spotlight; the Branch palette is open.

## Happy Path

| #   | Steps                                        | Expected Result                                                                                                                            |
| --- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Clean tree → pick an existing branch         | `selectBranch` checks out with no dialog; Spotlight closes AFTER checkout resolves                                                         |
| 2   | Clean tree → type a new name → create branch | `gitCreateBranch({ checkout: false })`, then `selectBranch(name)` performs the guarded checkout; "created" toast shown; modal closes after |
| 3   | Clean tree → "Checkout detached..."          | `selectBranch("HEAD")` runs the guarded checkout; detached-HEAD success toast shown; modal closes after                                    |

## Edge Cases

| #   | Scenario                                       | Steps                                                                                                                                       | Expected Result |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 1   | Dirty tree → pick branch                       | Checkout returns `uncommitted_changes` → `CheckoutConflictDialog` appears (stash/discard/cancel) BEFORE the modal closes (no teardown race) |
| 2   | Dirty tree → conflict dialog → Cancel          | No checkout performed; branch state rolled back; modal still closes (await-before-close)                                                    |
| 3   | Dirty tree → conflict dialog → Stash           | Changes stashed, branch checked out, success toast                                                                                          |
| 4   | Dirty tree → conflict dialog → Discard (force) | Force checkout, success toast                                                                                                               |
| 5   | Dirty tree → create-and-checkout               | Branch created (not checked out), then guarded `selectBranch` raises the conflict dialog on the dirty tree                                  |
| 6   | Dirty tree → checkout detached                 | `selectBranch("HEAD")` raises the conflict dialog instead of bypassing it                                                                   |

## Error / Degraded States

| #   | Scenario                                                                                | Steps                           | Expected Result                                                                             |
| --- | --------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | No repo selected                                                                        | Invoke any handler              | "No repo selected" error toast; no git call                                                 |
| 2   | Create branch fails                                                                     | `gitCreateBranch` returns false | "Failed to create branch" error toast; no checkout attempted                                |
| 3   | Backend returns errorType "unknown" but message says "would be overwritten by checkout" | checkout op                     | `inferErrorTypeFromText` classifies `uncommitted_changes` (so the conflict dialog can fire) |

## Accessibility

- [x] No change to keyboard/focus model of the palette.

## Acceptance Criteria

- [x] Step 1: create-and-checkout uses `checkout: false` then `selectBranch`.
- [x] Step 2: detached-HEAD routes through `selectBranch("HEAD")` (raw `gitCheckout` removed); success copy kept.
- [x] Step 3: all three handlers `await selectBranch(...)` BEFORE `closeModal()`.
- [x] Step 4: `gitErrorDialog` classifier detects `uncommitted_changes` for `checkout`. Full ActionSystem reroute now done — `branchOps.checkoutWithDialog` routes through the shared `runGuardedCheckout` core (see `src/services/git/operations/__tests__/TEST_CASES.md`).
- [ ] Step 5 (OUT OF SCOPE): "commit changes" conflict option NOT added — existing flow is stash/discard/cancel only.

## Notes / Follow-ups

- The ActionSystem path (`gitBranchActions.zod.ts` → `branchOps.checkoutWithDialog`)
  now shares the canonical guarded-checkout logic. The conflict-handling business
  logic was extracted out of `useBranchCheckout` into the plain async core
  `src/services/git/operations/guardedCheckout.ts` (`runGuardedCheckout`), which
  both `useBranchCheckout.selectBranch` and `branchOps.checkoutWithDialog` call.
  Both paths now surface the same `CheckoutConflictDialog`; the divergent
  `showGitErrorDialog` checkout branch is gone. `checkoutWithDialog` maps the
  core's result back onto the `{ success, message, errorType }` contract.

---

# Test Cases: Spotlight worktree management

## Preconditions

- A local git repository with a main worktree and at least two linked
  worktrees is selected.
- Spotlight is open on the Worktree palette.

## Happy Path

| #   | Steps                                       | Expected Result                                                                                             |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 1   | Inspect the active worktree row             | The row shows the primary check icon and no separate `Current` badge.                                       |
| 2   | Select `New Worktree...`                    | The existing worktree source modal opens and the create flow remains unchanged.                             |
| 3   | Select `Refresh`                            | The shared worktree cache reloads; the action is disabled while the refresh is in flight.                   |
| 4   | Select `Remove Worktree`, then a linked row | The selected worktree is removed through the canonical API and disappears after the shared cache refreshes. |
| 5   | Select `Done` from remove mode              | The palette returns to switch mode without closing Spotlight.                                               |

## Safety and Navigation

| #   | Scenario                        | Expected Result                                                                                       |
| --- | ------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | Main worktree in remove mode    | The main worktree is not listed and cannot be removed.                                                |
| 2   | Active linked worktree          | The active worktree is not listed in remove mode and cannot be removed from underneath the app.       |
| 3   | Backspace/Escape in remove mode | The first back action returns to switch mode; a subsequent back action returns to the parent palette. |
| 4   | Failed remove request           | The existing error dialog is shown, the row is re-enabled, and the cached worktree list is preserved. |
| 5   | Keyboard navigation             | Headers and disabled rows are skipped; list rows and pinned CRUD actions remain reachable.            |

## Acceptance Criteria

- [x] The active checkmark is the only current-worktree indicator.
- [x] Worktree switch/create/remove/refresh actions use one typed palette mode.
- [x] Removal delegates to the existing `RemoveWorktreeHandler` and refreshes
      `useWorktreeEntries` through the shared cache.
- [x] No new untranslated UI copy is introduced; existing common/worktree keys
      are reused.

---

# Test Cases: Spotlight row copy context menus

## Happy Path

| #   | Surface                    | Steps                                      | Expected Result                                                                                |
| --- | -------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| 1   | Worktree palette           | Right-click any worktree row               | Native menu shows `Copy Path`, `Copy Name`, and the platform-specific Reveal action.           |
| 2   | Branch palette             | Right-click any branch row                 | Native menu shows `Copy Name` and copies the full branch name.                                 |
| 3   | Default Spotlight branches | Search for a branch and right-click it     | The same branch-name copy action is available.                                                 |
| 4   | Workspace repo/folder rows | Right-click a repository or folder row     | Native menu copies its values and can reveal the normalized path in the platform file manager. |
| 5   | Saved multi-repo workspace | Right-click a saved workspace row          | Copy Name uses the workspace name; Copy Path and Reveal use its primary folder path.           |
| 6   | Recent/system path rows    | Right-click a recent or system-path result | Name, normalized filesystem path, and platform-specific Reveal actions are available.          |

## Edge Cases

| #   | Scenario                               | Expected Result                                                                  |
| --- | -------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Repo URI has `file://` or trailing `/` | Copy Path returns a plain normalized filesystem path.                            |
| 2   | Saved workspace has no primary folder  | Copy Path falls back to the first folder; it is omitted when no folder exists.   |
| 3   | Header or disabled row                 | No copy context menu opens and the row action is not triggered.                  |
| 4   | Copy API failure                       | Clipboard fallbacks run; a terminal failure is logged without closing Spotlight. |
| 5   | Right-click a selectable row           | The row is highlighted, but its normal select/switch action does not run.        |
| 6   | Branch row without a filesystem path   | Only `Copy Name` is shown; no Reveal action or empty separator is rendered.      |

## Acceptance Criteria

- [x] One shared native-menu implementation serves all Spotlight row types.
- [x] Copy targets are declarative item data; selector builders do not create
      their own menu UI.
- [x] `Copy Name` is translated in all 13 shipped locales; `Copy Path` reuses
      the existing translated action.
- [x] Filesystem-backed rows reuse the existing platform label resolver and
      Tauri reveal API; branch-only rows remain name-only.

---

# Test Cases: Branch Spotlight management scope

## Happy Path

| #   | Steps                                            | Expected Result                                                                     |
| --- | ------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 1   | Open Branch Spotlight and select `Delete Branch` | Manage mode lists only deletable branches.                                          |
| 2   | Select one or more branch rows                   | Selection checkboxes update and the bulk Delete action reflects the selected count. |
| 3   | Delete a selected branch                         | The branch deletion handler runs and the branch list refreshes.                     |

## Edge Cases

| #   | Scenario                                                                | Expected Result                                                                   |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | A non-current branch is checked out in a linked worktree                | It is omitted from Branch manage mode; no Remove Worktree row or action is shown. |
| 2   | The repository has only the current branch and worktree-backed branches | Manage mode shows no branch rows and retains only the Done action.                |
| 3   | Open Worktree Spotlight                                                 | Worktree removal remains available there and is unaffected by Branch management.  |

## Acceptance Criteria

- [x] Branch Spotlight exposes branch create, checkout, delete, and refresh flows only.
- [x] No worktree removal callback is accepted or invoked by `BranchPalette`.
- [x] Worktree CRUD remains owned by `WorktreePalette`.
