import { beforeEach, describe, expect, it, vi } from "vitest";

import { fetchRustApi } from "./client";
import { getGitDiffNumstatCombined } from "./diff";

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@src/hooks/logger", () => ({
  createLogger: () => ({
    error: mocks.error,
    warn: mocks.warn,
  }),
}));

vi.mock("./client", () => ({
  fetchRustApi: vi.fn(),
  gitRepoUrl: (repoId: string) => `/git/repos/${repoId}`,
}));

const fetchRustApiMock = vi.mocked(fetchRustApi);

describe("getGitDiffNumstatCombined", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("treats a concurrent worktree write as a non-fatal warning", async () => {
    fetchRustApiMock.mockRejectedValue(
      new Error(
        "Git operation failed: Failed to get patch: file changed before we could read it; class=Filesystem (30)"
      )
    );

    await expect(
      getGitDiffNumstatCombined({
        repo_id: "repo-1",
        repo_path: "/workspace/repo",
      })
    ).resolves.toBeUndefined();

    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining("worktree changed during the read")
    );
    expect(mocks.error).not.toHaveBeenCalled();
  });

  it("continues to report non-transient numstat failures as errors", async () => {
    const error = new Error("repository unavailable");
    fetchRustApiMock.mockRejectedValue(error);

    await expect(
      getGitDiffNumstatCombined({ repo_id: "repo-1" })
    ).resolves.toBeUndefined();

    expect(mocks.error).toHaveBeenCalledWith(
      "[GitAPI] Failed to get combined diff numstat:",
      error
    );
    expect(mocks.warn).not.toHaveBeenCalled();
  });
});
