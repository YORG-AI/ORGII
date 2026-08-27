import { describe, expect, it } from "vitest";

import {
  isGitHubPullRequestUrl,
  parseGitHubPullRequestUrl,
} from "../githubPullRequestUrl";

describe("parseGitHubPullRequestUrl", () => {
  it("parses a canonical pull request URL", () => {
    expect(
      parseGitHubPullRequestUrl("https://github.com/org2AI/ORG2/pull/851")
    ).toEqual({ owner: "org2AI", repo: "ORG2", number: 851 });
  });

  it("accepts sub-pages, query strings, fragments, and www host", () => {
    expect(
      parseGitHubPullRequestUrl(
        "https://www.github.com/org2AI/ORG2/pull/851/files?diff=split#top"
      )
    ).toEqual({ owner: "org2AI", repo: "ORG2", number: 851 });
    expect(
      parseGitHubPullRequestUrl("http://github.com/org2AI/ORG2/pull/7/")
    ).toEqual({ owner: "org2AI", repo: "ORG2", number: 7 });
  });

  it("rejects non-PR GitHub pages and other hosts", () => {
    expect(
      parseGitHubPullRequestUrl("https://github.com/org2AI/ORG2/issues/851")
    ).toBeNull();
    expect(
      parseGitHubPullRequestUrl("https://github.com/org2AI/ORG2/pulls")
    ).toBeNull();
    expect(
      parseGitHubPullRequestUrl(
        "https://github.com/org2AI/ORG2/commit/6c506a41a"
      )
    ).toBeNull();
    expect(
      parseGitHubPullRequestUrl("https://ghe.example.com/org/repo/pull/1")
    ).toBeNull();
    expect(
      parseGitHubPullRequestUrl("https://github.com/org2AI/ORG2/pull/abc")
    ).toBeNull();
    expect(parseGitHubPullRequestUrl("not a url")).toBeNull();
  });
});

describe("isGitHubPullRequestUrl", () => {
  it("mirrors the parser", () => {
    expect(
      isGitHubPullRequestUrl("https://github.com/org2AI/ORG2/pull/851")
    ).toBe(true);
    expect(isGitHubPullRequestUrl("https://example.com/pull/851")).toBe(false);
  });
});
