/** Stable sidebar identity for one managed-cloud Team Session row. */
export const CLOUD_REMOTE_ITEM_PREFIX = "cloudremote-";

export function buildCloudRemoteItemId(orgId: string, rowId: string): string {
  return `${CLOUD_REMOTE_ITEM_PREFIX}${orgId}|${rowId}`;
}

export function parseCloudRemoteItemId(
  itemId: string
): { orgId: string; rowId: string } | null {
  if (!itemId.startsWith(CLOUD_REMOTE_ITEM_PREFIX)) return null;
  const rest = itemId.slice(CLOUD_REMOTE_ITEM_PREFIX.length);
  const splitAt = rest.indexOf("|");
  if (splitAt <= 0) return null;
  return { orgId: rest.slice(0, splitAt), rowId: rest.slice(splitAt + 1) };
}

/**
 * Include one explicit navigation target without changing the user's saved
 * Team Sessions filter or resurrecting a locally hidden row.
 */
export function includeRevealedCloudRow<T extends { id: string }>(
  filteredRows: readonly T[],
  unhiddenRows: readonly T[],
  orgId: string | null,
  revealedMenuItemId?: string
): T[] {
  const filtered = [...filteredRows];
  const revealed = revealedMenuItemId
    ? parseCloudRemoteItemId(revealedMenuItemId)
    : null;
  if (!revealed || revealed.orgId !== orgId) return filtered;
  const target = unhiddenRows.find((row) => row.id === revealed.rowId);
  if (!target || filtered.some((row) => row.id === target.id)) return filtered;
  return [...filtered, target];
}
