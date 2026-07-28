import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getSharedGitStatusSnapshot,
  refreshSharedGitStatus,
  subscribeSharedGitStatus,
} from "./useSharedGitStatus";

const mocks = vi.hoisted(() => ({
  getGitStatus: vi.fn(),
  on: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock("@src/api/http/git/status", () => ({
  getGitStatus: mocks.getGitStatus,
}));

vi.mock("@src/api/realtime/codeEditorWebSocket", () => ({
  getCodeEditorWebSocket: () => ({ on: mocks.on }),
}));

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function statusFixture(files: { path: string; staged?: boolean }[] = []) {
  return {
    current_branch: "develop",
    current_upstream_branch: "origin/develop",
    current_tip: "abc123",
    branch_ahead_behind: { ahead: 0, behind: 0 },
    exists: true,
    merge_head_found: false,
    squash_msg_found: false,
    rebase_in_progress: false,
    cherry_pick_in_progress: false,
    do_conflicted_files_exist: false,
    working_directory: {
      files: files.map((file) => ({
        path: file.path,
        status: "M",
        staged: file.staged ?? false,
        original_path: null,
      })),
      staged_count: 0,
      unstaged_count: files.length,
      untracked_count: 0,
    },
  };
}

describe("shared git status store", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("shares one listener and request across consumers of the same repo", async () => {
    vi.useFakeTimers();
    let statusHandler: ((data: { repo_id?: string }) => void) | undefined;
    mocks.on.mockImplementation(
      (_event: string, handler: (data: { repo_id?: string }) => void) => {
        statusHandler = handler;
        return mocks.unsubscribe;
      }
    );
    mocks.getGitStatus.mockResolvedValue(
      statusFixture([{ path: "src/example.ts" }])
    );

    const firstConsumer = vi.fn();
    const secondConsumer = vi.fn();
    const unsubscribeFirst = subscribeSharedGitStatus(
      "repo-1",
      "/workspace/repo",
      firstConsumer
    );
    const unsubscribeSecond = subscribeSharedGitStatus(
      "repo-1",
      "/workspace/repo",
      secondConsumer
    );

    // Two consumers, one subscription, one request — this is the fan-out fix.
    expect(mocks.on).toHaveBeenCalledTimes(1);
    expect(mocks.on).toHaveBeenCalledWith(
      "repo:status_updated",
      expect.any(Function)
    );
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);

    await flushPromises();
    expect(firstConsumer).toHaveBeenCalledTimes(1);
    expect(secondConsumer).toHaveBeenCalledTimes(1);
    const snapshot = getSharedGitStatusSnapshot("repo-1", "/workspace/repo");
    expect(snapshot.initialLoading).toBe(false);
    expect(snapshot.error).toBeNull();
    expect(snapshot.status?.working_directory.files).toHaveLength(1);

    // An event for a different repo must not wake this entry.
    statusHandler?.({ repo_id: "another-repo" });
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);

    // One event for this repo produces exactly one request, not one per consumer.
    statusHandler?.({ repo_id: "repo-1" });
    await vi.advanceTimersByTimeAsync(300);
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(2);

    unsubscribeFirst();
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    unsubscribeSecond();
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("coalesces burst events into a single follow-up request", async () => {
    vi.useFakeTimers();
    let statusHandler: ((data: { repo_id?: string }) => void) | undefined;
    mocks.on.mockImplementation(
      (_event: string, handler: (data: { repo_id?: string }) => void) => {
        statusHandler = handler;
        return mocks.unsubscribe;
      }
    );
    mocks.getGitStatus.mockResolvedValue(statusFixture());

    const unsubscribe = subscribeSharedGitStatus(
      "repo-burst",
      "/workspace/burst",
      vi.fn()
    );
    await flushPromises();
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);

    statusHandler?.({ repo_id: "repo-burst" });
    statusHandler?.({ repo_id: "repo-burst" });
    statusHandler?.({ repo_id: "repo-burst" });
    await vi.advanceTimersByTimeAsync(300);

    expect(mocks.getGitStatus).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("issues a fresh request when a forced refresh races an in-flight one", async () => {
    mocks.on.mockReturnValue(mocks.unsubscribe);
    const first = deferred<ReturnType<typeof statusFixture>>();
    mocks.getGitStatus
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(statusFixture([{ path: "src/committed.ts" }]));

    const unsubscribe = subscribeSharedGitStatus(
      "repo-race",
      "/workspace/race",
      vi.fn()
    );
    expect(mocks.getGitStatus).toHaveBeenCalledTimes(1);

    // Forced refresh while the initial request is still open. The open request
    // may predate the mutation, so its result cannot be reused.
    const forced = refreshSharedGitStatus("repo-race", "/workspace/race");
    first.resolve(statusFixture());
    await forced;

    expect(mocks.getGitStatus).toHaveBeenCalledTimes(2);
    expect(
      getSharedGitStatusSnapshot("repo-race", "/workspace/race").status
        ?.working_directory.files
    ).toHaveLength(1);
    unsubscribe();
  });

  it("keeps the last good status and surfaces the error when a refresh fails", async () => {
    mocks.on.mockReturnValue(mocks.unsubscribe);
    mocks.getGitStatus
      .mockResolvedValueOnce(statusFixture([{ path: "src/keep.ts" }]))
      .mockRejectedValueOnce(new Error("git exploded"));

    const unsubscribe = subscribeSharedGitStatus(
      "repo-error",
      "/workspace/error",
      vi.fn()
    );
    await flushPromises();
    await refreshSharedGitStatus("repo-error", "/workspace/error");

    const snapshot = getSharedGitStatusSnapshot(
      "repo-error",
      "/workspace/error"
    );
    expect(snapshot.error).toBe("git exploded");
    expect(snapshot.status?.working_directory.files).toHaveLength(1);
    unsubscribe();
  });
});
