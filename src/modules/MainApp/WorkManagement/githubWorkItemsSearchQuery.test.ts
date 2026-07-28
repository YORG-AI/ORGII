import { describe, expect, it } from "vitest";

import {
  GITHUB_QUERY_SCOPE,
  GITHUB_QUERY_STATE,
  getIssuePageStatesForQuery,
  parseGitHubSearchQuery,
  serializeGitHubSearchQuery,
} from "./githubWorkItemsSearchQuery";

describe("GitHub work-item search query", () => {
  it("parses scopes, state, quoted qualifiers, and free text", () => {
    expect(
      parseGitHubSearchQuery(
        'is:issue is:closed label:"good first issue" author:@me crash report'
      )
    ).toEqual({
      scope: GITHUB_QUERY_SCOPE.ISSUE,
      state: GITHUB_QUERY_STATE.CLOSED,
      labels: ["good first issue"],
      author: "@me",
      assignee: null,
      freeText: "crash report",
    });
  });

  it("normalizes merged and conflicting scopes", () => {
    expect(parseGitHubSearchQuery("is:merged")).toMatchObject({
      scope: GITHUB_QUERY_SCOPE.PR,
      state: GITHUB_QUERY_STATE.MERGED,
    });
    expect(parseGitHubSearchQuery("is:issue is:pr").scope).toBe(
      GITHUB_QUERY_SCOPE.ALL
    );
  });

  it("round-trips supported qualifiers with spaces", () => {
    const parsed = parseGitHubSearchQuery(
      'is:issue state:all assignee:@me label:"needs review" hello'
    );
    expect(serializeGitHubSearchQuery(parsed)).toBe(
      'is:issue state:all assignee:@me label:"needs review" hello'
    );
  });

  it("selects issue request states without changing PR behavior", () => {
    expect(
      getIssuePageStatesForQuery(parseGitHubSearchQuery("is:issue is:open"))
    ).toEqual(["open"]);
    expect(
      getIssuePageStatesForQuery(parseGitHubSearchQuery("is:issue state:all"))
    ).toEqual(["open", "closed"]);
    expect(
      getIssuePageStatesForQuery(parseGitHubSearchQuery("is:pr is:open"))
    ).toEqual([]);
  });
});
