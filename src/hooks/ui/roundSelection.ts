/** A null selection follows the latest round as the round list grows. */
export type RoundSelection = number | null;

export const LATEST_ROUND_SELECTION = null;

/** Adapter for consumers whose existing pagination contract uses a number. */
export function roundSelectionToUnboundedIndex(
  selection: RoundSelection
): number {
  return selection === LATEST_ROUND_SELECTION
    ? Number.MAX_SAFE_INTEGER
    : selection;
}

function normalizePageCount(pageCount: number): number {
  if (!Number.isFinite(pageCount)) return 0;
  return Math.max(0, Math.trunc(pageCount));
}

/** Resolve a persisted selection to a valid index for the current page count. */
export function resolveRoundSelectionIndex(
  selection: RoundSelection,
  pageCount: number
): number {
  const normalizedPageCount = normalizePageCount(pageCount);
  if (normalizedPageCount === 0) return 0;

  const latestIndex = normalizedPageCount - 1;
  if (selection === LATEST_ROUND_SELECTION) return latestIndex;
  if (!Number.isFinite(selection)) return selection > 0 ? latestIndex : 0;
  return Math.min(Math.max(Math.trunc(selection), 0), latestIndex);
}

/**
 * Select an index, normalizing the final page back to the follow-latest state.
 */
export function selectRoundIndex(
  pageIndex: number,
  pageCount: number
): RoundSelection {
  const normalizedPageCount = normalizePageCount(pageCount);
  if (normalizedPageCount <= 1) return LATEST_ROUND_SELECTION;

  const resolvedIndex = resolveRoundSelectionIndex(pageIndex, pageCount);
  return resolvedIndex >= normalizedPageCount - 1
    ? LATEST_ROUND_SELECTION
    : resolvedIndex;
}

export function selectPreviousRound(
  selection: RoundSelection,
  pageCount: number
): RoundSelection {
  const normalizedPageCount = normalizePageCount(pageCount);
  if (normalizedPageCount <= 1) return LATEST_ROUND_SELECTION;

  const currentIndex = resolveRoundSelectionIndex(selection, pageCount);
  return selectRoundIndex(currentIndex - 1, normalizedPageCount);
}

export function selectNextRound(
  selection: RoundSelection,
  pageCount: number
): RoundSelection {
  const normalizedPageCount = normalizePageCount(pageCount);
  if (normalizedPageCount <= 1) return LATEST_ROUND_SELECTION;

  const currentIndex = resolveRoundSelectionIndex(selection, pageCount);
  return selectRoundIndex(currentIndex + 1, normalizedPageCount);
}

export function selectLatestRound(): RoundSelection {
  return LATEST_ROUND_SELECTION;
}
