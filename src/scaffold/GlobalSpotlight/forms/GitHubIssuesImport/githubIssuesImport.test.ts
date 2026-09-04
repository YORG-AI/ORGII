import { describe, expect, it } from "vitest";

import {
  createProjectSlug,
  createWorkItemPrefix,
  formatGitHubRepoInput,
  parseGitHubRepo,
} from "./githubIssuesImport";

describe("parseGitHubRepo", () => {
  it.each([
    ["ORGII/ORGII", { owner: "ORGII", repo: "ORGII" }],
    ["https://github.com/ORGII/ORGII.git", { owner: "ORGII", repo: "ORGII" }],
    ["git@github.com:ORGII/ORGII.git", { owner: "ORGII", repo: "ORGII" }],
  ])("normalizes %s", (input, expected) => {
    expect(parseGitHubRepo(input)).toEqual(expected);
  });

  it.each([
    "",
    "ORGII",
    "ORGII/ORGII/issues",
    "https://gitlab.com/ORGII/ORGII",
  ])("rejects %s", (input) => {
    expect(parseGitHubRepo(input)).toBeNull();
  });
});

describe("GitHub Issues import identifiers", () => {
  it("formats a repository URL as an owner/repo field value", () => {
    expect(formatGitHubRepoInput("https://github.com/ORGII/ORGII.git")).toBe(
      "ORGII/ORGII"
    );
    expect(formatGitHubRepoInput("https://gitlab.com/ORGII/ORGII")).toBe("");
  });

  it("creates stable project identifiers", () => {
    expect(createProjectSlug("ORGII Issues")).toBe("orgii-issues");
    expect(createProjectSlug("***")).toBe("github-issues");
    expect(createWorkItemPrefix("ORGII Issues")).toBe("ORG");
    expect(createWorkItemPrefix("A")).toBe("AXX");
    expect(createWorkItemPrefix("***")).toBe("GHI");
  });
});
