export const GITHUB_WORK_ITEMS_PAGE_SIZE = 25;

export function getGitHubWorkItemsPageCount(
  itemCount: number,
  pageSize: number = GITHUB_WORK_ITEMS_PAGE_SIZE
): number {
  return Math.max(1, Math.ceil(itemCount / pageSize));
}

export function getGitHubWorkItemsPage<T>(
  items: readonly T[],
  page: number,
  pageSize: number = GITHUB_WORK_ITEMS_PAGE_SIZE
): T[] {
  const safePage = Math.max(1, page);
  const start = (safePage - 1) * pageSize;
  return items.slice(start, start + pageSize);
}

export function canAdvanceGitHubWorkItemsPage(options: {
  currentPage: number;
  loadedPageCount: number;
  hasMoreRemoteItems: boolean;
}): boolean {
  return (
    options.currentPage < options.loadedPageCount || options.hasMoreRemoteItems
  );
}
