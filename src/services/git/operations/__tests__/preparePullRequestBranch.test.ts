import { beforeEach, describe, expect, it, vi } from "vitest";

import { preparePullRequestBranch } from "../preparePullRequestBranch";

const mocks = vi.hoisted(() => ({
  getPRLocal: vi.fn(),
  getGitBranches: vi.fn(),
  resolvePrWorktreeBase: vi.fn(),
  gitCreateBranch: vi.fn(),
}));
vi.mock("@src/api/http/git", () => ({ gitApi: mocks }));
vi.mock("@src/api/tauri/github", () => mocks);

const options = {
  repoId: "repo",
  repoPath: "/repos/app",
  repoFullName: "org/app",
  remote: "upstream",
  prNumber: 42,
  isActive: () => true,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.getPRLocal.mockResolvedValue({
    head: { ref: "feature", repo: { full_name: "org/app" } },
  });
  mocks.getGitBranches.mockResolvedValue({
    branches: [],
    current_branch: "main",
  });
  mocks.resolvePrWorktreeBase.mockResolvedValue({ headSha: "pr-head-sha" });
  mocks.gitCreateBranch.mockResolvedValue({ success: true });
});

describe("preparePullRequestBranch", () => {
  it("fetches the exact PR ref and creates a same-repo branch without checkout", async () => {
    expect(await preparePullRequestBranch(options)).toBe("feature");
    expect(mocks.resolvePrWorktreeBase).toHaveBeenCalledWith({
      repoPath: options.repoPath,
      prNumber: 42,
      remote: "upstream",
    });
    expect(mocks.gitCreateBranch).toHaveBeenCalledWith({
      repo_id: "repo",
      repo_path: options.repoPath,
      name: "feature",
      start_point: "pr-head-sha",
      checkout: false,
    });
  });
  it("isolates fork PRs from a same-named local or base-repo branch", async () => {
    mocks.getPRLocal.mockResolvedValue({
      head: { ref: "feature", repo: { full_name: "contributor/app" } },
    });
    mocks.getGitBranches.mockResolvedValue({
      branches: [{ name: "feature", branch_type: "local" }],
    });
    expect(await preparePullRequestBranch(options)).toBe("pr/42");
    expect(mocks.gitCreateBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "pr/42",
        start_point: "pr-head-sha",
        checkout: false,
      })
    );
  });
  it("preserves existing local commits instead of resetting or recreating a branch", async () => {
    mocks.getGitBranches.mockResolvedValue({
      branches: [{ name: "feature", branch_type: "local" }],
    });
    expect(await preparePullRequestBranch(options)).toBe("feature");
    expect(mocks.resolvePrWorktreeBase).not.toHaveBeenCalled();
    expect(mocks.gitCreateBranch).not.toHaveBeenCalled();
  });
  it("does not interpret branch loading failure as an empty repository", async () => {
    mocks.getGitBranches.mockResolvedValue(undefined);
    await expect(preparePullRequestBranch(options)).rejects.toThrow(
      "Could not read local branches"
    );
    expect(mocks.gitCreateBranch).not.toHaveBeenCalled();
  });
  it("propagates fetch or creation failures and never changes HEAD", async () => {
    mocks.resolvePrWorktreeBase.mockRejectedValueOnce(
      new Error("fetch failed")
    );
    await expect(preparePullRequestBranch(options)).rejects.toThrow(
      "fetch failed"
    );
    expect(mocks.gitCreateBranch).not.toHaveBeenCalled();
    mocks.gitCreateBranch.mockResolvedValueOnce({
      success: false,
      error: "branch already exists",
    });
    await expect(preparePullRequestBranch(options)).rejects.toThrow(
      "branch already exists"
    );
  });
  it("abandons a fetch completion after the picker closes", async () => {
    let active = true;
    mocks.resolvePrWorktreeBase.mockImplementation(async () => {
      active = false;
      return { headSha: "late-sha" };
    });
    expect(
      await preparePullRequestBranch({ ...options, isActive: () => active })
    ).toBeNull();
    expect(mocks.gitCreateBranch).not.toHaveBeenCalled();
  });
  it("rejects malformed PR data before fetching or writing branches", async () => {
    mocks.getPRLocal.mockResolvedValue({ head: {} });
    await expect(preparePullRequestBranch(options)).rejects.toThrow(
      "Pull request has no head branch"
    );
    expect(mocks.gitCreateBranch).not.toHaveBeenCalled();
  });
});
