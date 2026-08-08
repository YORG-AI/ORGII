import { afterEach, describe, expect, it, vi } from "vitest";

import { getGitCommits } from "@src/api/http/git/commits";
import type { GitCommitInfo } from "@src/api/http/git/types";

import {
  getCachedGitHistory,
  getGitHistoryResourceStats,
  loadGitHistory,
  resetGitHistoryResourceForTests,
  writeGitHistoryCache,
} from "./gitHistoryResource";

vi.mock("@src/api/http/git/commits", () => ({
  getGitCommits: vi.fn(),
}));

const getGitCommitsMock = vi.mocked(getGitCommits);

function commit(sha: string): GitCommitInfo {
  return {
    author: { date: "2026-07-31", email: "a@example.com", name: "Ada" },
    body: "",
    committer: { date: "2026-07-31", email: "a@example.com", name: "Ada" },
    parent_shas: [],
    sha,
    short_sha: sha.slice(0, 7),
    summary: `Commit ${sha}`,
  };
}

afterEach(() => {
  resetGitHistoryResourceForTests();
  vi.clearAllMocks();
});

describe("gitHistoryResource", () => {
  it("serves a remount from the repo-scoped cache without another request", async () => {
    getGitCommitsMock.mockResolvedValue({
      commits: [commit("abc1234")],
      total_count: 1,
    });
    const request = { limit: 25, repoId: "repo-1", repoPath: "/repo/one" };

    await expect(loadGitHistory(request)).resolves.toMatchObject({
      commits: [{ sha: "abc1234" }],
    });
    await expect(loadGitHistory(request)).resolves.toMatchObject({
      commits: [{ sha: "abc1234" }],
    });

    expect(getGitCommitsMock).toHaveBeenCalledTimes(1);
    expect(getCachedGitHistory(request)?.commits[0]?.sha).toBe("abc1234");
  });

  it("keeps repository scopes isolated and bounds retained histories", () => {
    for (let index = 0; index < 7; index += 1) {
      writeGitHistoryCache(
        {
          limit: 25,
          repoId: `repo-${index}`,
          repoPath: `/repo/${index}`,
        },
        { commits: [commit(String(index))], hasMore: false }
      );
    }

    expect(getGitHistoryResourceStats().entries).toBe(6);
    expect(
      getCachedGitHistory({
        limit: 25,
        repoId: "repo-0",
        repoPath: "/repo/0",
      })
    ).toBeNull();
    expect(
      getCachedGitHistory({
        limit: 25,
        repoId: "repo-6",
        repoPath: "/repo/6",
      })?.commits[0]?.sha
    ).toBe("6");
  });

  it("caps the remount snapshot while preserving pagination availability", () => {
    const request = { limit: 25, repoId: "repo-1", repoPath: "/repo/one" };
    writeGitHistoryCache(request, {
      commits: Array.from({ length: 205 }, (_, index) => commit(String(index))),
      hasMore: false,
    });

    const snapshot = getCachedGitHistory(request);
    expect(snapshot?.commits).toHaveLength(200);
    expect(snapshot?.hasMore).toBe(true);
  });
});
