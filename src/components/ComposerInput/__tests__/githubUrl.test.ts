import { describe, expect, it } from "vitest";

import { parseGitHubPillUrl } from "../githubUrl";

describe("parseGitHubPillUrl", () => {
  it("formats a repository URL as owner/repo", () => {
    expect(parseGitHubPillUrl("https://github.com/yorgai/org2")).toEqual({
      url: "https://github.com/yorgai/org2",
      displayName: "yorgai/org2",
      iconType: "repo",
    });
  });

  it.each([
    ["issues", "issue"],
    ["pull", "pr"],
  ] as const)("formats a GitHub %s URL as owner/repo#number", (path, type) => {
    expect(
      parseGitHubPillUrl(`https://github.com/yorgai/ORG2/${path}/406`)
    ).toEqual({
      url: `https://github.com/yorgai/ORG2/${path}/406`,
      displayName: "yorgai/ORG2#406",
      iconType: type,
    });
  });

  it("does not convert arbitrary GitHub subpaths", () => {
    expect(
      parseGitHubPillUrl("https://github.com/yorgai/org2/blob/main/README.md")
    ).toBeNull();
  });

  it("does not convert non-GitHub URLs", () => {
    expect(parseGitHubPillUrl("https://example.com/yorgai/org2")).toBeNull();
  });
});
