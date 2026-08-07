import { afterEach, describe, expect, it, vi } from "vitest";

import { GITHUB_LIST_CACHE_TTL_MS } from "@src/services/git/githubListCache";

import {
  getCachedOpsGitHubView,
  getOpsPrListStates,
  matchesOpsPrQueryState,
  setCachedOpsGitHubView,
} from "./githubWorkItemsViewCache";

describe("Kanban GitHub view cache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads closed PRs only for closed or merged views", () => {
    expect(getOpsPrListStates("open")).toEqual(["open"]);
    expect(getOpsPrListStates("closed")).toEqual(["closed"]);
    expect(getOpsPrListStates("merged")).toEqual(["closed"]);
    expect(getOpsPrListStates("all")).toEqual(["open", "closed"]);
  });

  it("groups merged PRs under Closed while preserving explicit Merged queries", () => {
    expect(matchesOpsPrQueryState("closed", "closed")).toBe(true);
    expect(matchesOpsPrQueryState("merged", "closed")).toBe(true);
    expect(matchesOpsPrQueryState("closed", "merged")).toBe(false);
    expect(matchesOpsPrQueryState("merged", "merged")).toBe(true);
  });

  it("retains only the active page snapshot for a scope", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T06:00:00.000Z"));

    setCachedOpsGitHubView("pr", {
      searchQuery: "is:pr is:open",
      currentPage: 2,
    });
    setCachedOpsGitHubView("pr", {
      searchQuery: "is:pr is:closed",
      currentPage: 3,
    });

    expect(getCachedOpsGitHubView("pr")).toMatchObject({
      searchQuery: "is:pr is:closed",
      currentPage: 3,
    });
  });

  it("offloads expired snapshots without a cleanup timer", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-12T06:00:00.000Z"));
    setCachedOpsGitHubView("issue", {
      searchQuery: "is:issue is:open",
      currentPage: 1,
    });

    vi.advanceTimersByTime(GITHUB_LIST_CACHE_TTL_MS + 1);

    expect(getCachedOpsGitHubView("issue")).toBeNull();
  });
});
