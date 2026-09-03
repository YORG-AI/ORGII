/**
 * showGitErrorAndHandle — the "Stash and Continue" recovery flow.
 *
 * Regression focus (2026-08-28 audit, C-2): the retry used to re-read the
 * pull-strategy setting instead of the strategy the failed pull ran with,
 * dropped remote/branch, returned silently when the retry failed (stranding
 * the stash), and popped `index: 0` instead of the stash it created.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gitStashPush = vi.fn();
const gitStashList = vi.fn();
const gitStashApply = vi.fn();
const gitPull = vi.fn();
const gitPush = vi.fn();
const showGitActionDialogSafely = vi.fn();
const askNativeDialogSafely = vi.fn();
const showGitErrorDialog = vi.fn();

vi.mock("@src/api/http/git", () => ({
  gitApi: {
    gitStashPush: (...args: unknown[]) => gitStashPush(...args),
    gitStashList: (...args: unknown[]) => gitStashList(...args),
    gitStashApply: (...args: unknown[]) => gitStashApply(...args),
    gitPull: (...args: unknown[]) => gitPull(...args),
    gitPush: (...args: unknown[]) => gitPush(...args),
  },
}));
vi.mock("@src/util/dialogs/gitActionDialog", () => ({
  showGitActionDialogSafely: (...args: unknown[]) =>
    showGitActionDialogSafely(...args),
}));
vi.mock("@src/util/dialogs/nativeDialog", () => ({
  askNativeDialogSafely: (...args: unknown[]) => askNativeDialogSafely(...args),
}));
vi.mock("@src/util/dialogs/gitErrorDialog", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showGitErrorDialog: (...args: unknown[]) => showGitErrorDialog(...args),
}));
vi.mock("@src/util/core/state/instrumentedStore", () => ({
  getInstrumentedStore: () => ({ get: () => "merge", set: () => undefined }),
}));
vi.mock("@src/store/workstation/tabs", () => ({
  createGitLogTab: vi.fn(),
  openWorkstationTabAtom: {},
  presentedWorkstationWorkspaceKeyAtom: {},
}));

const { showGitErrorAndHandle } = await import("./gitErrorDialog");

const BASE_OPTIONS = {
  operation: "pull",
  repoId: "repo-1",
  repoPath: "/tmp/repo",
  errorType: "uncommitted_changes" as const,
  errorMessage: "would be overwritten",
};

function stashEntry(index: number, sha: string) {
  return { index, message: `stash ${sha}`, branch: "main", commit_sha: sha };
}

beforeEach(() => {
  vi.clearAllMocks();
  showGitErrorDialog.mockResolvedValue("stash-and-continue");
  gitStashPush.mockResolvedValue({ success: true, stash_ref: "stash@{0}" });
  gitStashList.mockResolvedValue({ stashes: [stashEntry(0, "sha-fresh")] });
  gitStashApply.mockResolvedValue({ success: true });
  gitPull.mockResolvedValue({ success: true });
  gitPush.mockResolvedValue({ success: true });
  askNativeDialogSafely.mockResolvedValue(true);
});

describe("stash-and-continue", () => {
  it("retries the pull with the parameters the failed pull ran with", async () => {
    await showGitErrorAndHandle({
      ...BASE_OPTIONS,
      retryContext: { remote: "origin", branch: "main", strategy: "rebase" },
    });

    expect(gitStashPush).toHaveBeenCalledWith(
      expect.objectContaining({ include_untracked: true })
    );
    expect(gitPull).toHaveBeenCalledWith(
      expect.objectContaining({
        remote: "origin",
        branch: "main",
        strategy: "rebase",
      })
    );
    expect(gitPush).not.toHaveBeenCalled();
  });

  it("falls back to the configured strategy without a retry context", async () => {
    await showGitErrorAndHandle(BASE_OPTIONS);

    expect(gitPull).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "merge" })
    );
  });

  it("offers to restore the stash even when the retry fails", async () => {
    gitPull.mockRejectedValueOnce(new Error("still failing"));

    await showGitErrorAndHandle(BASE_OPTIONS);

    expect(askNativeDialogSafely).toHaveBeenCalledWith(
      expect.stringContaining("retry failed"),
      expect.anything()
    );
    expect(gitStashApply).toHaveBeenCalledWith(
      expect.objectContaining({ pop: true })
    );
  });

  it("pops the stash by its commit id, not by position", async () => {
    // Between the auto-stash and the restore, something else pushed a stash:
    // the fresh entry moved from index 0 to index 1.
    gitStashList
      .mockResolvedValueOnce({ stashes: [stashEntry(0, "sha-fresh")] })
      .mockResolvedValueOnce({
        stashes: [stashEntry(0, "sha-interloper"), stashEntry(1, "sha-fresh")],
      });

    await showGitErrorAndHandle(BASE_OPTIONS);

    expect(gitStashApply).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, pop: true })
    );
  });

  it("does not pop anything when the auto-stash is gone from the list", async () => {
    gitStashList
      .mockResolvedValueOnce({ stashes: [stashEntry(0, "sha-fresh")] })
      .mockResolvedValueOnce({ stashes: [stashEntry(0, "sha-other")] });

    await showGitErrorAndHandle(BASE_OPTIONS);

    expect(gitStashApply).not.toHaveBeenCalled();
    expect(showGitActionDialogSafely).toHaveBeenCalledWith(
      expect.stringContaining("no longer in the stash list"),
      "info"
    );
  });

  it("keeps the stash and says so for operations it cannot retry", async () => {
    await showGitErrorAndHandle({ ...BASE_OPTIONS, operation: "checkout" });

    expect(gitPull).not.toHaveBeenCalled();
    expect(gitStashApply).not.toHaveBeenCalled();
    expect(showGitActionDialogSafely).toHaveBeenCalledWith(
      expect.stringContaining("Retry this operation manually"),
      "info"
    );
  });

  it("retries sync as pull followed by push", async () => {
    await showGitErrorAndHandle({ ...BASE_OPTIONS, operation: "sync" });

    expect(gitPull).toHaveBeenCalledTimes(1);
    expect(gitPush).toHaveBeenCalledTimes(1);
    expect(gitPull.mock.invocationCallOrder[0]).toBeLessThan(
      gitPush.mock.invocationCallOrder[0]
    );
  });
});
