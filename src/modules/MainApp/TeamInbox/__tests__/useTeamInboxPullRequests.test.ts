import { describe, expect, it, vi } from "vitest";

import { REPO_KIND, type Repo } from "@src/store/repo";

import { selectTeamInboxPullRequestRepos } from "../useTeamInboxPullRequests";

const repos: Repo[] = [
  {
    id: "repo-a",
    name: "Desktop",
    kind: REPO_KIND.GIT,
    path: "/repos/desktop",
    repo_url: "github.com/acme/desktop",
  },
  {
    id: "repo-b",
    name: "Server",
    kind: REPO_KIND.GIT,
    path: "/repos/server",
    repo_url: "github.com/other/server",
  },
];

describe("selectTeamInboxPullRequestRepos", () => {
  it("keeps the existing local behavior when no cloud Org is active", () => {
    const matcher = vi.fn(() => false);

    expect(selectTeamInboxPullRequestRepos(repos, null, {}, matcher)).toBe(
      repos
    );
    expect(matcher).not.toHaveBeenCalled();
  });

  it("passes only repositories selected in the active Org scope", () => {
    const matcher = vi.fn(
      (repo: { repo_url?: string | null }, scopes: string[]) =>
        Boolean(repo.repo_url && scopes.includes(repo.repo_url))
    );

    expect(
      selectTeamInboxPullRequestRepos(
        repos,
        "org-a",
        {
          "org-a": ["github.com/acme/desktop"],
          "org-b": ["github.com/other/server"],
        },
        matcher
      )
    ).toEqual([repos[0]]);
    expect(matcher).toHaveBeenCalledTimes(2);
    expect(matcher).toHaveBeenCalledWith(
      {
        repo_url: "github.com/acme/desktop",
        fs_uri: "/repos/desktop",
      },
      ["github.com/acme/desktop"]
    );
  });

  it("loads no repositories when the active Org has no defined scopes", () => {
    const matcher = vi.fn(() => true);

    expect(
      selectTeamInboxPullRequestRepos(repos, "org-a", {}, matcher)
    ).toEqual([]);
    expect(
      selectTeamInboxPullRequestRepos(
        repos,
        "org-a",
        { "org-b": ["github.com/other/server"] },
        matcher
      )
    ).toEqual([]);
    expect(matcher).not.toHaveBeenCalled();
  });
});
