export interface VirtualizedGroup<TGroup, TItem> {
  key: string;
  group: TGroup;
  items: readonly TItem[];
}

export interface VirtualizedGroupRow<TGroup, TItem> {
  group: TGroup;
  groupKey: string;
  item: TItem;
  isLastInGroup: boolean;
}

export interface VirtualizedGroupModel<TGroup, TItem> {
  groupCounts: number[];
  rows: VirtualizedGroupRow<TGroup, TItem>[];
}

/**
 * Build GroupedVirtuoso's compact data model. Collapsed groups keep their
 * header entry while their row references are omitted.
 */
export function buildVirtualizedGroupModel<
  const TEntry extends VirtualizedGroup<unknown, unknown>,
>(
  groups: readonly TEntry[],
  isExpanded: (group: TEntry) => boolean
): VirtualizedGroupModel<TEntry["group"], TEntry["items"][number]> {
  const groupCounts: number[] = [];
  const rows: VirtualizedGroupRow<TEntry["group"], TEntry["items"][number]>[] =
    [];

  for (const group of groups) {
    const count = isExpanded(group) ? group.items.length : 0;
    groupCounts.push(count);
    for (let index = 0; index < count; index += 1) {
      rows.push({
        group: group.group,
        groupKey: group.key,
        item: group.items[index],
        isLastInGroup: index === count - 1,
      });
    }
  }

  return { groupCounts, rows };
}
