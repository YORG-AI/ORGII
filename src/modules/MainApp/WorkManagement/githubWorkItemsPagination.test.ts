import { describe, expect, it } from "vitest";

import {
  GITHUB_WORK_ITEMS_PAGE_SIZE,
  canAdvanceGitHubWorkItemsPage,
  getGitHubWorkItemsPage,
  getGitHubWorkItemsPageCount,
} from "./githubWorkItemsPagination";

describe("GitHub work-item pagination", () => {
  it("splits loaded items into 25-row pages", () => {
    const items = Array.from({ length: 58 }, (_, index) => index + 1);

    expect(GITHUB_WORK_ITEMS_PAGE_SIZE).toBe(25);
    expect(getGitHubWorkItemsPageCount(items.length)).toBe(3);
    expect(getGitHubWorkItemsPage(items, 1)).toEqual(items.slice(0, 25));
    expect(getGitHubWorkItemsPage(items, 2)).toEqual(items.slice(25, 50));
    expect(getGitHubWorkItemsPage(items, 3)).toEqual(items.slice(50));
  });

  it("keeps empty result sets on a single page", () => {
    expect(getGitHubWorkItemsPageCount(0)).toBe(1);
    expect(getGitHubWorkItemsPage([], 1)).toEqual([]);
  });

  it("allows next-page loading at the remote boundary", () => {
    expect(
      canAdvanceGitHubWorkItemsPage({
        currentPage: 2,
        loadedPageCount: 2,
        hasMoreRemoteItems: true,
      })
    ).toBe(true);
    expect(
      canAdvanceGitHubWorkItemsPage({
        currentPage: 2,
        loadedPageCount: 2,
        hasMoreRemoteItems: false,
      })
    ).toBe(false);
  });
});
