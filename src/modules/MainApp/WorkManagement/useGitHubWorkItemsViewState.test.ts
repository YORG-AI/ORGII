import { describe, expect, it } from "vitest";

import { parseGitHubSearchQuery } from "./githubWorkItemsSearchQuery";
import {
  GITHUB_FILTER_PRESET,
  applyGitHubPersonalFilters,
  getSelectedGitHubPersonalFilters,
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
});
