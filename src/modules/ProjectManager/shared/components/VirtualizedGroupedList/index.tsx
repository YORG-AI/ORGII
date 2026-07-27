import React, { useCallback, useMemo, useState } from "react";
import { GroupedVirtuoso } from "react-virtuoso";

import { type VirtualizedGroup, buildVirtualizedGroupModel } from "./model";

interface VirtualizedGroupedListProps<
  TEntry extends VirtualizedGroup<unknown, unknown>,
> {
  groups: readonly TEntry[];
  defaultExpanded: (group: TEntry) => boolean;
  getItemKey: (
    item: TEntry["items"][number],
    group: TEntry["group"]
  ) => React.Key;
  renderGroupHeader: (
    group: TEntry["group"],
    expanded: boolean,
    onExpandedChange: (expanded: boolean) => void
  ) => React.ReactNode;
  renderItem: (
    item: TEntry["items"][number],
    group: TEntry["group"],
    isLastInGroup: boolean
  ) => React.ReactNode;
  className?: string;
  testId?: string;
}

/**
 * Shared grouped-list window for Project Manager surfaces. Authoritative item
 * arrays remain parent-owned; only the visible expanded rows are referenced by
 * the virtualizer's derived data model.
 */
export default function VirtualizedGroupedList<
  const TEntry extends VirtualizedGroup<unknown, unknown>,
>({
  groups,
  defaultExpanded,
  getItemKey,
  renderGroupHeader,
  renderItem,
  className,
  testId,
}: VirtualizedGroupedListProps<TEntry>) {
  const [expandedOverrides, setExpandedOverrides] = useState<
    ReadonlyMap<string, boolean>
  >(() => new Map());

  const isExpanded = useCallback(
    (group: TEntry) =>
      expandedOverrides.get(group.key) ?? defaultExpanded(group),
    [defaultExpanded, expandedOverrides]
  );

  const model = useMemo(
    () => buildVirtualizedGroupModel(groups, isExpanded),
    [groups, isExpanded]
  );

  const virtualKeys = useMemo(() => {
    const keys: React.Key[] = [];
    let rowIndex = 0;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
      const group = groups[groupIndex];
      keys.push(`group:${group.key}`);
      const itemCount = model.groupCounts[groupIndex] ?? 0;
      for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
        const row = model.rows[rowIndex];
        rowIndex += 1;
        if (row) {
          keys.push(`item:${String(getItemKey(row.item, row.group))}`);
        }
      }
    }
    return keys;
  }, [getItemKey, groups, model]);

  const handleExpandedChange = useCallback(
    (groupKey: string, expanded: boolean) => {
      setExpandedOverrides((current) => {
        const next = new Map(current);
        next.set(groupKey, expanded);
        return next;
      });
    },
    []
  );

  const computeItemKey = useCallback(
    (index: number): React.Key => virtualKeys[index] ?? `row:${index}`,
    [virtualKeys]
  );

  return (
    <GroupedVirtuoso
      className={className}
      data-testid={testId}
      groupCounts={model.groupCounts}
      computeItemKey={computeItemKey}
      defaultItemHeight={44}
      increaseViewportBy={{ top: 160, bottom: 320 }}
      style={{ height: "100%" }}
      groupContent={(groupIndex) => {
        const group = groups[groupIndex];
        if (!group) return null;
        const expanded = isExpanded(group);
        return renderGroupHeader(group.group, expanded, (nextExpanded) =>
          handleExpandedChange(group.key, nextExpanded)
        );
      }}
      itemContent={(index) => {
        const row = model.rows[index];
        return row ? renderItem(row.item, row.group, row.isLastInGroup) : null;
      }}
    />
  );
}

export type { VirtualizedGroup } from "./model";
