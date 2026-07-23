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
export function buildVirtualizedGroupModel<TGroup, TItem>(
  groups: readonly VirtualizedGroup<TGroup, TItem>[],
  isExpanded: (group: VirtualizedGroup<TGroup, TItem>) => boolean
): VirtualizedGroupModel<TGroup, TItem> {
  const groupCounts: number[] = [];
  const rows: VirtualizedGroupRow<TGroup, TItem>[] = [];

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
