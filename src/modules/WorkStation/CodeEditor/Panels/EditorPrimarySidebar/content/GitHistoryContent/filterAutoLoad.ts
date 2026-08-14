/**
 * Bounds for the message-filter auto-paging chain in Git History.
 *
 * The commit filter matches client-side over the pages already loaded, so a
 * query with no match on the current page keeps requesting the next page to
 * keep older matches discoverable. Without a bound that walks the entire
 * repository history into React state — an unbounded, purely incidental
 * memory cost for a single keystroke. The chain is therefore capped, and the
 * user can spend another window explicitly from the empty state.
 */
export const MAX_FILTER_AUTO_SCAN_COMMITS = 500;

export interface FilterScanInput {
  /** Undefined while the history list is unfiltered. */
  filterQuery: string | undefined;
  /** Commits matching the current filter across everything loaded so far. */
  matchCount: number;
  /** Commits currently held in component state. */
  loadedCommitCount: number;
  hasMore: boolean;
  /** Defaults to {@link MAX_FILTER_AUTO_SCAN_COMMITS}. */
  maxScannedCommits?: number;
}

function isUnmatchedFilterScan(input: FilterScanInput): boolean {
  return Boolean(input.filterQuery) && input.matchCount === 0 && input.hasMore;
}

/** Whether the filter chain may pull one more page automatically. */
export function shouldAutoLoadMoreForFilter(input: FilterScanInput): boolean {
  if (!isUnmatchedFilterScan(input)) return false;
  return (
    input.loadedCommitCount <
    (input.maxScannedCommits ?? MAX_FILTER_AUTO_SCAN_COMMITS)
  );
}

/** Whether the chain stopped on its bound rather than on exhausted history. */
export function isFilterScanCapped(input: FilterScanInput): boolean {
  if (!isUnmatchedFilterScan(input)) return false;
  return (
    input.loadedCommitCount >=
    (input.maxScannedCommits ?? MAX_FILTER_AUTO_SCAN_COMMITS)
  );
}

/**
 * Budget granted for the current query. A budget recorded for a different
 * query is ignored, so changing the filter always restarts from the default
 * bound without an extra state-resetting effect.
 */
export interface FilterScanBudget {
  query: string;
  limit: number;
}

export function resolveFilterScanBudget(
  budget: FilterScanBudget | null,
  filterQuery: string | undefined
): number {
  if (!budget || !filterQuery || budget.query !== filterQuery) {
    return MAX_FILTER_AUTO_SCAN_COMMITS;
  }
  return budget.limit;
}

/** Grant one more scan window from the currently loaded position. */
export function extendFilterScanBudget(
  filterQuery: string | undefined,
  loadedCommitCount: number
): FilterScanBudget {
  return {
    query: filterQuery ?? "",
    limit: loadedCommitCount + MAX_FILTER_AUTO_SCAN_COMMITS,
  };
}
