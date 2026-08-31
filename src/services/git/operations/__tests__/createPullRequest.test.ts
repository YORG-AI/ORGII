// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchRustApi } from "@src/api/http/git/client";
import { gitPush } from "@src/api/http/git/operations";
import { getGitRemotes } from "@src/api/http/git/remotes";
import { createPRLocal } from "@src/api/tauri/github";
import {
  BRANCH_REMOTE_MUTATION_EVENT,
  type BranchRemoteMutationDetail,
} from "@src/util/git/branchRemoteMutation";

import { createPullRequest } from "../createPullRequest";

vi.mock("@src/api/http/git/client", () => ({
  fetchRustApi: vi.fn(),
  gitRepoUrl: (repoId: string) => `/git/repos/${repoId}`,
}));
vi.mock("@src/api/http/git/operations", () => ({ gitPush: vi.fn() }));
vi.mock("@src/api/http/git/remotes", () => ({ getGitRemotes: vi.fn() }));
vi.mock("@src/api/tauri/github", () => ({ createPRLocal: vi.fn() }));

describe("createPullRequest", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("invalidates branch status after GitHub creates the PR", async () => {
    vi.mocked(getGitRemotes).mockResolvedValue({
      remotes: [
        {
          name: "origin",
          url: "git@github.com:acme/repo.git",
          fetch_url: "git@github.com:acme/repo.git",
          push_url: "git@github.com:acme/repo.git",
        },
      ],
    });
    vi.mocked(gitPush).mockResolvedValue({ success: true } as never);
    vi.mocked(fetchRustApi).mockResolvedValue({
      data: { name: "develop" },
    } as never);
    vi.mocked(createPRLocal).mockResolvedValue({
      url: "https://github.com/acme/repo/pull/12",
    } as never);
    const details: BranchRemoteMutationDetail[] = [];
    const listener = (event: Event) => {
      details.push((event as CustomEvent<BranchRemoteMutationDetail>).detail);
    };
    window.addEventListener(BRANCH_REMOTE_MUTATION_EVENT, listener);

    try {
      await expect(
        createPullRequest({
          repoId: "repo-1",
          repoPath: "/repo",
          branch: "feature",
          title: "Feature",
        })
      ).resolves.toEqual({ url: "https://github.com/acme/repo/pull/12" });
    } finally {
      window.removeEventListener(BRANCH_REMOTE_MUTATION_EVENT, listener);
    }

    expect(details).toEqual([
      {
        repoId: "repo-1",
        repoPath: "/repo",
        branchName: "feature",
        reason: "pull-request-created",
      },
    ]);
  });
});
