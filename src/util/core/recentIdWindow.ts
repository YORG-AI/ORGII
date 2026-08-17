/**
 * Bounded most-recently-used id list.
 *
 * Shared by keep-alive surfaces that only want the active item plus a small
 * window of recently active ones mounted (terminal panes, browser-tab
 * webviews). Newest first. Returns the same reference when nothing changes
 * so React state setters stay no-ops.
 */
export function pushRecentId(
  prev: readonly string[],
  id: string,
  maxEntries: number
): readonly string[] {
  if (prev[0] === id) return prev;
  return [id, ...prev.filter((entry) => entry !== id)].slice(0, maxEntries);
}
