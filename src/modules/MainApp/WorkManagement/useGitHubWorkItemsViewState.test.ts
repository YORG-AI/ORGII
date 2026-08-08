import { describe, expect, it } from "vitest";

import { parseGitHubSearchQuery } from "./githubWorkItemsSearchQuery";
import {
  GITHUB_FILTER_PRESET,
  applyGitHubPersonalFilters,
  getSelectedGitHubPersonalFilters,
  normalizeGitHubSearchQueryForScope,
} from "./useGitHubWorkItemsViewState";

describe("GitHub work-items view state model", () => {
  it("applies and clears personal filter presets", () => {
    const query = parseGitHubSearchQuery("is:issue is:open");
    applyGitHubPersonalFilters(query, [
      GITHUB_FILTER_PRESET.BY_ME,
      GITHUB_FILTER_PRESET.ASSIGNED_TO_ME,
    ]);
    expect(query).toMatchObject({ author: "@me", assignee: "@me" });
    applyGitHubPersonalFilters(query, []);
    expect(query).toMatchObject({ author: null, assignee: null });
  });

  it("projects selected personal filters in stable order", () => {
    const query = parseGitHubSearchQuery(
      "is:issue is:open author:@me assignee:@me"
    );
    expect(getSelectedGitHubPersonalFilters(query)).toEqual([
      GITHUB_FILTER_PRESET.BY_ME,
      GITHUB_FILTER_PRESET.ASSIGNED_TO_ME,
    ]);
  });

  it("keeps the PR inbox open-only while preserving its search text", () => {
    expect(
      normalizeGitHubSearchQueryForScope(
        "pr",
        "is:pr is:merged author:@me sidebar"
      )
    ).toBe("is:pr is:open author:@me sidebar");
  });

  it("keeps an editable separator after qualifiers and typed search terms", () => {
    expect(
      normalizeGitHubSearchQueryForScope("issue", "is:issue is:open")
    ).toBe("is:issue is:open ");
    expect(
      normalizeGitHubSearchQueryForScope("issue", "is:issue is:open 68 ")
    ).toBe("is:issue is:open 68 ");
  });

  it("repairs text typed directly after a state qualifier", () => {
    expect(
      normalizeGitHubSearchQueryForScope("issue", "is:issue is:open68")
    ).toBe("is:issue is:open 68");
  });
});
