# Test Cases: `runGuardedCheckout` (Issue #17 de-dup)

The single guarded-checkout core shared by the hook path
(`useBranchCheckout.selectBranch`) and the ActionSystem service path
(`branchOps.checkoutWithDialog`). It checks out a ref and, when the working tree
is dirty, surfaces the unified `CheckoutConflictDialog` (stash / discard /
cancel) via an injected `onConflict` callback.

> Pure logic covered by Vitest in `guardedCheckout.test.ts`. `gitApi` is mocked
> with `vi.mock`; the conflict dialog is a `vi.fn()` passed as `onConflict`, so
> no Tauri dialog or HTTP call runs. The repo's UI-feature workflow forbids
> `.tsx` / testing-library tests, so the modal + atom orchestration in the hook
> is verified manually / by the agent harness.

## Preconditions

- `gitApi.gitCheckout` / `gitApi.gitStashPush` are mocked.
- `onConflict` resolves to `"stash" | "force" | "cancel"`.

## Happy Path

| #   | Scenario      | Steps                                      | Expected Result                                                                         |
| --- | ------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| 1   | Clean tree    | `gitCheckout` resolves `{ success: true }` | `{ success: true, outcome: "checked-out", errorType: "none" }`; `onConflict` not called |
| 2   | `create` flag | Clean checkout with `create: true`         | `gitCheckout` called with `create: true`                                                |

## Edge Cases — uncommitted_changes conflict

| #   | Choice | Steps                                     | Expected Result                                                                                |
| --- | ------ | ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | stash  | conflict → stash push ok → re-checkout ok | `{ success: true, outcome: "stashed", message: "Switched to … Changes stashed." }`             |
| 2   | force  | conflict → force checkout ok              | `{ success: true, outcome: "forced", message: "Switched to …" }`; no stash call                |
| 3   | cancel | conflict → user cancels                   | `{ success: false, outcome: "cancelled", errorType: "uncommitted_changes" }`; no recovery call |

## Error / Degraded States

| #   | Scenario                   | Steps                                                 | Expected Result                                                               |
| --- | -------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Non-conflict failure       | `gitCheckout` → `{ success:false, branch_not_found }` | `{ success:false, outcome:"error", errorType:"branch_not_found" }`; no dialog |
| 2   | Missing error message      | failure with no `error` field                         | message falls back to `Failed to checkout branch "<ref>"`                     |
| 3   | Checkout throws            | `gitCheckout` rejects                                 | `{ success:false, outcome:"error", errorType:"other", message:<err> }`        |
| 4   | Stash push returns nothing | conflict → stash → `undefined`                        | `{ success:false, outcome:"error", message:"Failed to stash changes" }`       |
| 4b  | Stash push reports failure | conflict → stash → `{ success:false, message }` (the shape the wrapper actually returns on error) | `{ success:false, outcome:"error", message:<stash error> }`; no checkout attempted |
| 5   | Post-stash checkout fails  | conflict → stash ok → re-checkout fails               | `{ success:false, outcome:"error", message:<checkout error> }`                |
| 6   | Stash push throws          | conflict → stash rejects                              | `{ success:false, outcome:"error", message:"Failed to stash and checkout" }`  |
| 7   | Force checkout fails       | conflict → force checkout fails                       | `{ success:false, outcome:"error", message:<force error> }`                   |

## Contract mapping (`branchOps.checkoutWithDialog`)

- `runGuardedCheckout` result → `{ success, message, errorType }` `GitOperationResult`.
- `errorType` mapped via `toGitErrorType`: `none → none`, `uncommitted_changes →
uncommitted_changes`, everything else → `unknown`.

## Acceptance Criteria

- [x] All branch outcomes covered by Vitest.
- [x] `onConflict` is the sole entry point to the conflict dialog (no direct UI import in the core).
- [x] Core never throws; always resolves a normalized result.
- [x] ActionSystem `{ success, message, errorType }` contract preserved.
