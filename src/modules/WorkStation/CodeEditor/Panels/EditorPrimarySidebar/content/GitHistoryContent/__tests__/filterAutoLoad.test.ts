import { describe, expect, it } from "vitest";

import {
  MAX_FILTER_AUTO_SCAN_COMMITS,
  extendFilterScanBudget,
  isFilterScanCapped,
  resolveFilterScanBudget,
  shouldAutoLoadMoreForFilter,
} from "../filterAutoLoad";

function scan(
  overrides: Partial<Parameters<typeof isFilterScanCapped>[0]> = {}
) {
  return {
    filterQuery: "fix",
    matchCount: 0,
    loadedCommitCount: 25,
    hasMore: true,
    ...overrides,
  };
}

describe("shouldAutoLoadMoreForFilter", () => {
  it("pages the next window while the filter has no match", () => {
    expect(shouldAutoLoadMoreForFilter(scan())).toBe(true);
  });

  it("stops as soon as the filter matches something", () => {
    expect(shouldAutoLoadMoreForFilter(scan({ matchCount: 1 }))).toBe(false);
  });

  it("stops without a filter query", () => {
    expect(shouldAutoLoadMoreForFilter(scan({ filterQuery: "" }))).toBe(false);
  });

  it("stops when history is exhausted", () => {
    expect(shouldAutoLoadMoreForFilter(scan({ hasMore: false }))).toBe(false);
  });

  it("stops at the scan bound instead of paging the whole repository", () => {
    expect(
      shouldAutoLoadMoreForFilter(
        scan({ loadedCommitCount: MAX_FILTER_AUTO_SCAN_COMMITS })
      )
    ).toBe(false);
    expect(
      shouldAutoLoadMoreForFilter(
        scan({ loadedCommitCount: MAX_FILTER_AUTO_SCAN_COMMITS - 1 })
      )
    ).toBe(true);
  });

  it("honors an explicitly granted larger bound", () => {
    expect(
      shouldAutoLoadMoreForFilter(
        scan({
          loadedCommitCount: MAX_FILTER_AUTO_SCAN_COMMITS,
          maxScannedCommits: MAX_FILTER_AUTO_SCAN_COMMITS * 2,
        })
      )
    ).toBe(true);
  });
});

describe("isFilterScanCapped", () => {
  it("reports the bound only when the chain stopped on it", () => {
    expect(
      isFilterScanCapped(
        scan({ loadedCommitCount: MAX_FILTER_AUTO_SCAN_COMMITS })
      )
    ).toBe(true);
    expect(isFilterScanCapped(scan({ loadedCommitCount: 25 }))).toBe(false);
  });

  it("does not report the bound when history simply ran out", () => {
    expect(
      isFilterScanCapped(
        scan({
          loadedCommitCount: MAX_FILTER_AUTO_SCAN_COMMITS,
          hasMore: false,
        })
      )
    ).toBe(false);
  });

  it("does not report the bound once a match exists", () => {
    expect(
      isFilterScanCapped(
        scan({
          loadedCommitCount: MAX_FILTER_AUTO_SCAN_COMMITS,
          matchCount: 3,
        })
      )
    ).toBe(false);
  });
});

describe("filter scan budget", () => {
  it("defaults to the base bound when no budget was granted", () => {
    expect(resolveFilterScanBudget(null, "fix")).toBe(
      MAX_FILTER_AUTO_SCAN_COMMITS
    );
  });

  it("defaults to the base bound for an unfiltered list", () => {
    expect(resolveFilterScanBudget(null, undefined)).toBe(
      MAX_FILTER_AUTO_SCAN_COMMITS
    );
    expect(
      resolveFilterScanBudget(extendFilterScanBudget("", 0), undefined)
    ).toBe(MAX_FILTER_AUTO_SCAN_COMMITS);
  });

  it("ignores a budget granted for a different query", () => {
    const budget = extendFilterScanBudget("fix", 500);
    expect(resolveFilterScanBudget(budget, "fix")).toBe(1_000);
    expect(resolveFilterScanBudget(budget, "refactor")).toBe(
      MAX_FILTER_AUTO_SCAN_COMMITS
    );
  });

  it("grants one more window from the current position", () => {
    expect(extendFilterScanBudget("fix", 500)).toEqual({
      query: "fix",
      limit: 500 + MAX_FILTER_AUTO_SCAN_COMMITS,
    });
  });
});
