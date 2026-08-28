/**
 * handlePullError — the "Stash & Pull" / "Discard & Pull" recovery flow.
 *
 * Regression focus: the stash path used to stash WITHOUT untracked files and
 * never restored the stash — the user's changes vanished into stash@{0}
 * behind a "Changes stashed" toast.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitFile } from "@src/types/git/types";

import { handlePullError } from "./pullErrorHandlers";

vi.mock("@src/components/GitDialogs", () => ({
  PullConflictDialog: { open: vi.fn() },
  RebaseConflictDialog: { open: vi.fn() },
}));

const { PullConflictDialog, RebaseConflictDialog } =
  await import("@src/components/GitDialogs");

const pullConflictOpen = vi.mocked(PullConflictDialog.open);
const rebaseConflictOpen = vi.mocked(RebaseConflictDialog.open);

function makeFile(path: string, staged = false): GitFile {
  return { path, staged, status: "modified" } as unknown as GitFile;
}

function makeOptions(
  overrides: Partial<Parameters<typeof handlePullError>[0]> = {}
) {
  return {
    pullResult: { success: false, errorType: "uncommitted_changes" as const },
    currentBranch: "feature/x",
    currentFiles: [makeFile("src/a.ts")],
    doPull: vi.fn().mockResolvedValue({ success: true, errorType: "none" }),
    stashPush: vi.fn().mockResolvedValue(true),
    stashPop: vi.fn().mockResolvedValue(true),
    dispatch: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handlePullError — uncommitted_changes → Stash & Pull", () => {
  it("stashes with untracked files, retries the pull, and restores the stash", async () => {
    pullConflictOpen.mockResolvedValueOnce("stash_pull");
    const stashPush = vi.fn().mockResolvedValue(true);
    const doPull = vi
      .fn()
      .mockResolvedValue({ success: true, errorType: "none" as const });
    const stashPop = vi.fn().mockResolvedValue(true);
    const options = makeOptions({ stashPush, doPull, stashPop });

    const handled = await handlePullError(options);

    expect(handled).toBe(true);
    expect(stashPush).toHaveBeenCalledWith(
      "Auto-stash before pulling into feature/x",
      true
    );
    expect(doPull).toHaveBeenCalledTimes(1);
    // The restore is the point of "Stash & Pull": the user asked to pull,
    // not to move their changes into the stash.
    expect(stashPop).toHaveBeenCalledWith(0);
    expect(stashPush.mock.invocationCallOrder[0]).toBeLessThan(
      doPull.mock.invocationCallOrder[0]
    );
    expect(doPull.mock.invocationCallOrder[0]).toBeLessThan(
      stashPop.mock.invocationCallOrder[0]
    );
  });

  it("still attempts the restore when the retried pull fails", async () => {
    pullConflictOpen.mockResolvedValueOnce("stash_pull");
    const options = makeOptions({
      doPull: vi
        .fn()
        .mockResolvedValue({ success: false, errorType: "unknown" }),
    });

    const handled = await handlePullError(options);

    expect(handled).toBe(true);
    expect(options.stashPop).toHaveBeenCalledWith(0);
  });

  it("does not retry the pull or pop when the stash itself fails", async () => {
    pullConflictOpen.mockResolvedValueOnce("stash_pull");
    const options = makeOptions({
      stashPush: vi.fn().mockResolvedValue(false),
    });

    const handled = await handlePullError(options);

    expect(handled).toBe(true);
    expect(options.doPull).not.toHaveBeenCalled();
    expect(options.stashPop).not.toHaveBeenCalled();
  });

  it("does nothing when the user cancels the dialog", async () => {
    pullConflictOpen.mockResolvedValueOnce("cancel");
    const options = makeOptions();

    const handled = await handlePullError(options);

    expect(handled).toBe(true);
    expect(options.stashPush).not.toHaveBeenCalled();
    expect(options.doPull).not.toHaveBeenCalled();
    expect(options.stashPop).not.toHaveBeenCalled();
  });

  it("offers only unstaged files in the dialog listing", async () => {
    pullConflictOpen.mockResolvedValueOnce("cancel");
    const options = makeOptions({
      currentFiles: [makeFile("a.ts"), makeFile("b.ts", true)],
    });

    await handlePullError(options);

    expect(pullConflictOpen).toHaveBeenCalledWith(
      expect.objectContaining({ conflictingFiles: ["a.ts"] })
    );
  });
});

describe("handlePullError — other error types", () => {
  it("dispatches merge abort when the user aborts a conflicted pull", async () => {
    rebaseConflictOpen.mockResolvedValueOnce("abort");
    const options = makeOptions({
      pullResult: { success: false, errorType: "merge_conflicts" },
    });

    const handled = await handlePullError(options);

    expect(handled).toBe(true);
    expect(options.dispatch).toHaveBeenCalledWith("git.mergeAbort", {}, "user");
  });

  it("returns false for unrecognized error types", async () => {
    const options = makeOptions({
      pullResult: { success: false, errorType: "network_error" },
    });

    const handled = await handlePullError(options);

    expect(handled).toBe(false);
    expect(pullConflictOpen).not.toHaveBeenCalled();
  });
});
