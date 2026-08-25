import { describe, expect, it } from "vitest";

import {
  createGitHubPrTabDataFromLink,
  getHttpLinkPreview,
  remoteUrlsMatchGitHubPullRequest,
} from "./LinkHoverCard.helpers";

describe("getHttpLinkPreview", () => {
  it("builds a compact preview for HTTPS links", () => {
    expect(
      getHttpLinkPreview("https://www.example.com/docs/start?q=codex")
    ).toEqual({
      url: "https://www.example.com/docs/start?q=codex",
      host: "example.com",
      displayUrl: "www.example.com/docs/start?q=codex",
    });
  });

  it("preserves local development hosts and ports", () => {
    expect(getHttpLinkPreview("http://localhost:1998")).toEqual({
      url: "http://localhost:1998/",
      host: "localhost:1998",
      displayUrl: "localhost:1998",
    });
  });

  it("does not create hover previews for non-web protocols", () => {
    expect(getHttpLinkPreview("mailto:hello@example.com")).toBeNull();
    expect(getHttpLinkPreview("file:///tmp/report.html")).toBeNull();
    expect(getHttpLinkPreview("javascript:alert(1)")).toBeNull();
  });

  it("does not create hover previews for template placeholders", () => {
    expect(getHttpLinkPreview("http://${host}:${port}/docs")).toBeNull();
  });
});

describe("GitHub pull-request hover actions", () => {
  const pullRequest = { owner: "org2AI", repo: "ORG2", number: 964 };

  it("matches GitHub HTTPS and SSH remotes for the PR repository", () => {
    expect(
      remoteUrlsMatchGitHubPullRequest(pullRequest, [
        "git@github.com:org2AI/ORG2.git",
      ])
    ).toBe(true);
    expect(
      remoteUrlsMatchGitHubPullRequest(pullRequest, [
        "https://github.com/another/repository.git",
      ])
    ).toBe(false);
  });

  it("builds the existing PR-tab payload from GitHub detail", () => {
    expect(
      createGitHubPrTabDataFromLink({
        url: "https://github.com/org2AI/ORG2/pull/964",
        repoPath: "/repos/ORG2",
        repoId: "repo-1",
        detail: {
          title: "Use split open action",
          html_url: "https://github.com/org2AI/ORG2/pull/964",
          state: "open",
          draft: false,
          merged: false,
          head: { ref: "feature/split-open" },
          base: { ref: "dev" },
          updated_at: "2026-08-25T12:00:00Z",
          additions: 12,
          deletions: 3,
        },
      })
    ).toEqual({
      prNumber: 964,
      prTitle: "Use split open action",
      prUrl: "https://github.com/org2AI/ORG2/pull/964",
      prStatus: "open",
      headBranch: "feature/split-open",
      baseBranch: "dev",
      updatedAt: "2026-08-25T12:00:00Z",
      additions: 12,
      deletions: 3,
      repoPath: "/repos/ORG2",
      repoId: "repo-1",
    });
  });
});
