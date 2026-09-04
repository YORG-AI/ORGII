import { describe, expect, it, vi } from "vitest";

import type { GitHubIssue } from "@src/api/tauri/github";

import {
  extractGitHubReferences,
  getWorkItemReferenceText,
  loadGitHubReferences,
  parseGitHubRepoFromItemUrl,
} from "./references";

function issue(
  repo: string,
  number: number,
  kind: "issue" | "pr" = "issue"
): GitHubIssue {
  return {
    id: number,
    number,
    title: `${kind} ${number}`,
    body: null,
    state: "open",
    state_reason: null,
    html_url: `https://github.com/${repo}/${kind === "pr" ? "pull" : "issues"}/${number}`,
    created_at: "2026-09-03T00:00:00Z",
    updated_at: "2026-09-03T00:00:00Z",
    closed_at: null,
    user: { login: "octocat", avatar_url: "" },
    labels: [],
    assignees: [],
    comments: 0,
    milestone: null,
  };
}

describe("GitHub linked-reference extraction", () => {
  it("collects URL, cross-repo, and same-repo references in text order", () => {
    const references = extractGitHubReferences(
      [
        "Fix https://github.com/acme/app/pull/12 before acme/api#9.",
        "Then follow #44 and ignore duplicate acme/app#12.",
      ].join("\n"),
      { defaultRepoFullName: "acme/app" }
    );

    expect(references).toEqual([
      {
        repoFullName: "acme/app",
        number: 12,
        kind: "pr",
        source: "https://github.com/acme/app/pull/12",
      },
      {
        repoFullName: "acme/api",
        number: 9,
        kind: "unknown",
        source: "acme/api#9",
      },
      {
        repoFullName: "acme/app",
        number: 44,
        kind: "unknown",
        source: "#44",
      },
    ]);
  });

  it("shares Work Item description and comment text and can exclude itself", () => {
    const text = getWorkItemReferenceText({
      spec: "Description links #7",
      comments: [
        {
          id: "comment-1",
          author: "ada",
          content: "Comment links org/repo#8",
          created_at: "2026-09-03T00:00:00Z",
        },
      ],
    });

    expect(text).toContain("Description links #7");
    expect(text).toContain("Comment links org/repo#8");
    expect(
      extractGitHubReferences("#7 and #8", {
        defaultRepoFullName: "org/repo",
        exclude: { repoFullName: "org/repo", number: 7 },
      })
    ).toEqual([
      {
        repoFullName: "org/repo",
        number: 8,
        kind: "unknown",
        source: "#8",
      },
    ]);
    expect(
      parseGitHubRepoFromItemUrl("https://github.com/OpenAI/example/issues/42")
    ).toBe("OpenAI/example");
  });
});

describe("loadGitHubReferences", () => {
  it("resolves the default repository once and classifies fetched PRs", async () => {
    const resolveDefaultRepoFullName = vi.fn().mockResolvedValue("acme/app");
    const getIssue = vi
      .fn()
      .mockImplementation((repo: string, number: number) =>
        Promise.resolve(issue(repo, number, number === 12 ? "pr" : "issue"))
      );

    const result = await loadGitHubReferences(
      [
        { repoFullName: null, number: 12, kind: "unknown", source: "#12" },
        { repoFullName: null, number: 15, kind: "unknown", source: "#15" },
      ],
      { resolveDefaultRepoFullName, getIssue }
    );

    expect(resolveDefaultRepoFullName).toHaveBeenCalledOnce();
    expect(getIssue).toHaveBeenCalledTimes(2);
    expect(result.map(({ number, kind }) => ({ number, kind }))).toEqual([
      { number: 12, kind: "pr" },
      { number: 15, kind: "issue" },
    ]);
  });

  it("caps concurrent GitHub requests", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const getIssue = vi.fn(async (repo: string, number: number) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active -= 1;
      return issue(repo, number);
    });

    const loading = loadGitHubReferences(
      [1, 2, 3, 4].map((number) => ({
        repoFullName: "acme/app",
        number,
        kind: "unknown" as const,
        source: `#${number}`,
      })),
      { getIssue, concurrency: 2 }
    );

    await vi.waitFor(() => expect(getIssue).toHaveBeenCalledTimes(2));
    releases.splice(0).forEach((release) => release());
    await vi.waitFor(() => expect(getIssue).toHaveBeenCalledTimes(4));
    releases.splice(0).forEach((release) => release());
    await loading;

    expect(maxActive).toBe(2);
  });
});
