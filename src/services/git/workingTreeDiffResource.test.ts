import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadWorkingTreeDiff,
  releaseWorkingTreeDiff,
  resetWorkingTreeDiffResourceForTests,
} from "./workingTreeDiffResource";

const mocks = vi.hoisted(() => ({
  getGitBatchFileDiffs: vi.fn(),
}));

vi.mock("@src/api/http/git/diff", () => ({
  getGitBatchFileDiffs: mocks.getGitBatchFileDiffs,
}));

const trackedRequest = {
  repoId: "repo-1",
  repoPath: "/workspace/repo",
  file: {
    path: "/workspace/repo/src/example.ts",
    status: "modified" as const,
    staged: false,
    original_path: null,
  },
};

function response(oldContent = "before", newContent = "after") {
  return {
    files: [
      {
        file_path: "src/example.ts",
        old_path: null,
        status: "modified" as const,
        old_content: oldContent,
        new_content: newContent,
        insertions: 1,
        deletions: 1,
        hunks: [],
        binary: false,
      },
    ],
  };
}

afterEach(() => {
  resetWorkingTreeDiffResourceForTests();
  vi.clearAllMocks();
});

describe("workingTreeDiffResource", () => {
  it("shares one full-diff request across concurrent consumers", async () => {
    let resolveRequest!: (value: ReturnType<typeof response>) => void;
    mocks.getGitBatchFileDiffs.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );

    const first = loadWorkingTreeDiff(trackedRequest);
    const second = loadWorkingTreeDiff(trackedRequest);

    expect(first).toBe(second);
    expect(mocks.getGitBatchFileDiffs).toHaveBeenCalledTimes(1);
    resolveRequest(response());

    await expect(first).resolves.toMatchObject({
      oldContent: "before",
      newContent: "after",
      additions: 1,
      deletions: 1,
    });
    await expect(second).resolves.toMatchObject({ newContent: "after" });
  });

  it("uses a bounded settled cache until the rendered body is released", async () => {
    mocks.getGitBatchFileDiffs.mockResolvedValue(response());

    await loadWorkingTreeDiff(trackedRequest);
    await loadWorkingTreeDiff(trackedRequest);
    expect(mocks.getGitBatchFileDiffs).toHaveBeenCalledTimes(1);

    releaseWorkingTreeDiff(trackedRequest);
    await loadWorkingTreeDiff(trackedRequest);
    expect(mocks.getGitBatchFileDiffs).toHaveBeenCalledTimes(2);
  });

  it("does not retain a single oversized diff body", async () => {
    mocks.getGitBatchFileDiffs.mockResolvedValue(
      response("x".repeat(2_200_000), "y".repeat(2_200_000))
    );

    await loadWorkingTreeDiff(trackedRequest);
    await loadWorkingTreeDiff(trackedRequest);

    expect(mocks.getGitBatchFileDiffs).toHaveBeenCalledTimes(2);
  });

  it("keeps tracked and untracked request keys separate", async () => {
    mocks.getGitBatchFileDiffs.mockResolvedValue(response());

    await Promise.all([
      loadWorkingTreeDiff(trackedRequest),
      loadWorkingTreeDiff({
        ...trackedRequest,
        file: { ...trackedRequest.file, status: "added", staged: false },
      }),
    ]);

    expect(mocks.getGitBatchFileDiffs).toHaveBeenCalledTimes(2);
    expect(mocks.getGitBatchFileDiffs).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ from_ref: "HEAD" })
    );
    expect(mocks.getGitBatchFileDiffs).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ from_ref: "EMPTY" })
    );
  });
});
