export function shouldShowTurnPaginationSpinner(params: {
  turnPaginationReady: boolean;
  pageCount: number;
}): boolean {
  // A loaded session with no rounds is a stable empty state, not an
  // indefinitely loading page. ChatHistory owns the initial-load indicator;
  // this selector only spins while an existing round is still hydrating.
  return !params.turnPaginationReady && params.pageCount > 0;
}
