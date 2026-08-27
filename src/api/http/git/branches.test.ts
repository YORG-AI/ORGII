import { beforeEach, describe, expect, it, vi } from "vitest";

import { getGitBranches } from "./branches";
import { branchRequestCache, fetchRustApi } from "./client";

vi.mock("./client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client")>();
  return { ...actual, fetchRustApi: vi.fn() };
});

const fetchRustApiMock = vi.mocked(fetchRustApi);

beforeEach(() => {
  vi.clearAllMocks();
  branchRequestCache.clear();
  fetchRustApiMock.mockReturnValue(new Promise(() => {}));
});

describe("getGitBranches request deduplication", () => {
  it("does not share one in-flight response between a main checkout and a worktree of the same repo", () => {
    void getGitBranches({ repo_id: "repo-1", repo_path: "/main/checkout" });
    void getGitBranches({ repo_id: "repo-1", repo_path: "/worktrees/feature" });

    expect(fetchRustApiMock).toHaveBeenCalledTimes(2);
  });

  it("still dedupes identical concurrent requests", () => {
    void getGitBranches({ repo_id: "repo-1", repo_path: "/main/checkout" });
    void getGitBranches({ repo_id: "repo-1", repo_path: "/main/checkout" });

    expect(fetchRustApiMock).toHaveBeenCalledTimes(1);
  });
});
