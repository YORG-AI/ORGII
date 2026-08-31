/**
 * Unit tests for the shared guarded-checkout core (Issue #17 de-dup).
 *
 * Covers every branch outcome of `runGuardedCheckout`:
 * success (clean tree), uncommitted_changes → stash / force / cancel, the
 * recovery failure paths, non-conflict errors, and a thrown checkout.
 * `gitApi` is mocked so no real git/HTTP calls happen.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { runGuardedCheckout } from "../guardedCheckout";

const gitCheckout = vi.fn();
const gitStashPush = vi.fn();

vi.mock("@src/api/http/git", () => ({
  gitApi: {
    gitCheckout: (...args: unknown[]) => gitCheckout(...args),
    gitStashPush: (...args: unknown[]) => gitStashPush(...args),
  },
}));

function conflict(choice: "stash" | "force" | "cancel") {
  return vi.fn().mockResolvedValue(choice);
}

const BASE = {
  repoId: "repo-1",
  repoPath: "/tmp/repo",
  ref: "feature",
} as const;

beforeEach(() => {
  gitCheckout.mockReset();
  gitStashPush.mockReset();
});

describe("runGuardedCheckout — clean tree", () => {
  it("returns checked-out without invoking the conflict dialog", async () => {
    gitCheckout.mockResolvedValueOnce({ success: true });
    const onConflict = conflict("stash");

    const result = await runGuardedCheckout({ ...BASE, onConflict });

    expect(result).toEqual({
      success: true,
      outcome: "checked-out",
      errorType: "none",
    });
    expect(onConflict).not.toHaveBeenCalled();
    expect(gitStashPush).not.toHaveBeenCalled();
  });

  it("forwards the create flag to the checkout call", async () => {
    gitCheckout.mockResolvedValueOnce({ success: true });

    await runGuardedCheckout({
      ...BASE,
      create: true,
      onConflict: conflict("cancel"),
    });

    expect(gitCheckout).toHaveBeenCalledWith({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      ref: "feature",
      create: true,
    });
  });
});

describe("runGuardedCheckout — non-conflict failure", () => {
  it("returns an error, shows the blocked dialog, and never shows the dirty-tree conflict dialog", async () => {
    gitCheckout.mockResolvedValueOnce({
      success: false,
      errorType: "branch_not_found",
      error: "Branch not found.",
    });
    const onConflict = conflict("stash");
    const onBlocked = vi.fn().mockResolvedValue(undefined);

    const result = await runGuardedCheckout({
      ...BASE,
      onConflict,
      onBlocked,
    });

    expect(result).toEqual({
      success: false,
      outcome: "error",
      errorType: "branch_not_found",
      message: "Branch not found.",
      blocked: true,
    });
    expect(onConflict).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledWith({
      branch: "feature",
      errorType: "branch_not_found",
      message: "Branch not found.",
    });
  });

  it("surfaces a worktree branch-in-use blocker through onBlocked", async () => {
    gitCheckout.mockResolvedValueOnce({
      success: false,
      errorType: "worktree_branch_in_use",
      error: "fatal: 'feature' is already checked out at '/tmp/wt'",
    });
    const onConflict = conflict("stash");
    const onBlocked = vi.fn().mockResolvedValue(undefined);

    const result = await runGuardedCheckout({
      ...BASE,
      onConflict,
      onBlocked,
    });

    expect(result).toEqual({
      success: false,
      outcome: "error",
      errorType: "worktree_branch_in_use",
      message: "fatal: 'feature' is already checked out at '/tmp/wt'",
      blocked: true,
    });
    expect(onConflict).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledWith({
      branch: "feature",
      errorType: "worktree_branch_in_use",
      message: "fatal: 'feature' is already checked out at '/tmp/wt'",
    });
  });

  it("falls back to a default message when none is supplied", async () => {
    gitCheckout.mockResolvedValueOnce({ success: false, errorType: "other" });

    const result = await runGuardedCheckout({
      ...BASE,
      onConflict: conflict("cancel"),
    });

    expect(result.success).toBe(false);
    expect(result.message).toBe('Failed to checkout branch "feature"');
  });

  it("returns an error and shows the blocked dialog when the checkout call throws", async () => {
    gitCheckout.mockRejectedValueOnce(new Error("network down"));
    const onBlocked = vi.fn().mockResolvedValue(undefined);

    const result = await runGuardedCheckout({
      ...BASE,
      onConflict: conflict("stash"),
      onBlocked,
    });

    expect(result).toEqual({
      success: false,
      outcome: "error",
      errorType: "other",
      message: "network down",
      blocked: true,
    });
    expect(onBlocked).toHaveBeenCalledWith({
      branch: "feature",
      errorType: "other",
      message: "network down",
    });
  });
});

describe("runGuardedCheckout — uncommitted_changes → stash", () => {
  it("stashes then re-checks out and reports stashed success", async () => {
    gitCheckout
      .mockResolvedValueOnce({
        success: false,
        errorType: "uncommitted_changes",
      })
      .mockResolvedValueOnce({ success: true });
    gitStashPush.mockResolvedValueOnce({
      success: true,
      stash_ref: "stash@{0}",
    });

    const result = await runGuardedCheckout({
      ...BASE,
      onConflict: conflict("stash"),
    });

    expect(result).toEqual({
      success: true,
      outcome: "stashed",
      errorType: "none",
      message: "Switched to feature. Changes stashed.",
    });
    expect(gitStashPush).toHaveBeenCalledTimes(1);
    expect(gitCheckout).toHaveBeenCalledTimes(2);
  });

  it("returns an error when the stash push returns nothing", async () => {
    gitCheckout.mockResolvedValueOnce({
      success: false,
      errorType: "uncommitted_changes",
    });
    gitStashPush.mockResolvedValueOnce(undefined);

    const result = await runGuardedCheckout({
      ...BASE,
      onConflict: conflict("stash"),
    });

    expect(result).toEqual({
      success: false,
      outcome: "error",
      errorType: "uncommitted_changes",
      message: "Failed to stash changes",
    });
    expect(gitCheckout).toHaveBeenCalledTimes(1);
  });

  // Regression: gitStashPush never actually returns undefined on error — its
  // wrapper catches and returns { success: false, message } — and the old
  // undefined-only guard let that sail into a checkout on a still-dirty tree.
  it("returns an error when the stash push reports failure", async () => {
    gitCheckout.mockResolvedValueOnce({
      success: false,
      errorType: "uncommitted_changes",
    });
    gitStashPush.mockResolvedValueOnce({
      success: false,
      message: "fatal: unable to write new index file",
      stash_ref: null,
    });

    const result = await runGuardedCheckout({
      ...BASE,
      onConflict: conflict("stash"),
    });

    expect(result).toEqual({
      success: false,
      outcome: "error",
      errorType: "uncommitted_changes",
      message: "fatal: unable to write new index file",
    });
    expect(gitCheckout).toHaveBeenCalledTimes(1);
  });

  it("returns an error when the post-stash checkout fails", async () => {
    gitCheckout
      .mockResolvedValueOnce({
        success: false,
        errorType: "uncommitted_changes",
      })
      .mockResolvedValueOnce({
        success: false,
        errorType: "other",
        error: "still dirty",
      });
    gitStashPush.mockResolvedValueOnce({ success: true });
    const onBlocked = vi.fn().mockResolvedValue(undefined);

    const result = await runGuardedCheckout({
      ...BASE,
      onConflict: conflict("stash"),
      onBlocked,
    });

    expect(result).toEqual({
      success: false,
      outcome: "error",
      errorType: "other",
      message: "still dirty",
      blocked: true,
    });
    expect(onBlocked).toHaveBeenCalledWith({
      branch: "feature",
      errorType: "other",
      message: "still dirty",
    });
  });

  it("returns an error when the stash push throws", async () => {
    gitCheckout.mockResolvedValueOnce({
      success: false,
      errorType: "uncommitted_changes",
    });
    gitStashPush.mockRejectedValueOnce(new Error("boom"));

    const result = await runGuardedCheckout({
      ...BASE,
      onConflict: conflict("stash"),
    });

    expect(result).toEqual({
      success: false,
      outcome: "error",
      errorType: "other",
      message: "Failed to stash and checkout",
    });
  });
});

describe("runGuardedCheckout — uncommitted_changes → force", () => {
  it("force-checks out and reports forced success", async () => {
    gitCheckout
      .mockResolvedValueOnce({
        success: false,
        errorType: "uncommitted_changes",
      })
      .mockResolvedValueOnce({ success: true });

    const result = await runGuardedCheckout({
      ...BASE,
      onConflict: conflict("force"),
    });

    expect(result).toEqual({
      success: true,
      outcome: "forced",
      errorType: "none",
      message: "Switched to feature",
    });
    expect(gitStashPush).not.toHaveBeenCalled();
    expect(gitCheckout).toHaveBeenLastCalledWith({
      repo_id: "repo-1",
      repo_path: "/tmp/repo",
      ref: "feature",
      force: true,
    });
  });

  it("returns an error when the force checkout fails", async () => {
    gitCheckout
      .mockResolvedValueOnce({
        success: false,
        errorType: "uncommitted_changes",
      })
      .mockResolvedValueOnce({
        success: false,
        errorType: "other",
        error: "cannot force",
      });

    const onBlocked = vi.fn().mockResolvedValue(undefined);

    const result = await runGuardedCheckout({
      ...BASE,
      onConflict: conflict("force"),
      onBlocked,
    });

    expect(result).toEqual({
      success: false,
      outcome: "error",
      errorType: "other",
      message: "cannot force",
      blocked: true,
    });
    expect(onBlocked).toHaveBeenCalledWith({
      branch: "feature",
      errorType: "other",
      message: "cannot force",
    });
  });
});

describe("runGuardedCheckout — uncommitted_changes → cancel", () => {
  it("reports a non-success cancelled outcome without any recovery call", async () => {
    gitCheckout.mockResolvedValueOnce({
      success: false,
      errorType: "uncommitted_changes",
    });

    const result = await runGuardedCheckout({
      ...BASE,
      onConflict: conflict("cancel"),
    });

    expect(result).toEqual({
      success: false,
      outcome: "cancelled",
      errorType: "uncommitted_changes",
      message: 'Checkout of "feature" cancelled. Local changes were kept.',
    });
    expect(gitStashPush).not.toHaveBeenCalled();
    expect(gitCheckout).toHaveBeenCalledTimes(1);
  });
});
