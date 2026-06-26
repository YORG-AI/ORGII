import { FileText } from "lucide-react";
import { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { TREE_ROW_HEIGHT, TreeRowBase } from "@src/components/TreeRow";
import type { TreeRowNode } from "@src/components/TreeRow";
import { VirtualizedStickyTree } from "@src/components/VirtualizedStickyTree";
import type {
  FlattenedTreeNode,
  TreeNodeBase,
} from "@src/components/VirtualizedStickyTree";
import type { TabDragPillPayload } from "@src/modules/WorkStation/shared/TabBar/tabDragTypes";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { ReferenceDragGhost } from "@src/shared/dnd/ReferenceDragGhost";
import { useReferencePillDrag } from "@src/shared/dnd/useReferencePillDrag";

import type { DiffFileSectionData } from "../DiffFileSection";

export interface DiffFileNavigationItem<TFile extends DiffFileSectionData> {
  key: string;
  file: TFile;
  entryIds?: string[];
}

export interface DiffFileNavigationListProps<
  TFile extends DiffFileSectionData,
> {
  items: Array<DiffFileNavigationItem<TFile>>;
  selectedEntryId?: string | null;
  selectedPath?: string | null;
  onSelectItem: (item: DiffFileNavigationItem<TFile>) => void;
  emptyTitle?: string;
  enableDragToInput?: boolean;
}

interface DiffFileNavigationTreeNode<
  TFile extends DiffFileSectionData,
> extends TreeNodeBase {
  item: DiffFileNavigationItem<TFile>;
  rowNode: TreeRowNode;
}

function getFileName(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.split("/").pop() || normalized;
}

function buildTreeNode<TFile extends DiffFileSectionData>(
  item: DiffFileNavigationItem<TFile>
): FlattenedTreeNode<DiffFileNavigationTreeNode<TFile>> {
  const rowPath = item.file.path;
  const rowName = getFileName(rowPath);
  const rowNode: TreeRowNode = {
    id: item.key,
    name: rowName,
    path: rowPath,
    type: "file",
    ...(rowName
      ? {}
      : { icon: <FileText size={14} className="text-text-3" /> }),
  };

  return {
    node: {
      path: item.key,
      name: rowName,
      isFolder: false,
      item,
      rowNode,
    },
    depth: 0,
  };
}

function DiffNavigationRow<TFile extends DiffFileSectionData>({
  item,
  isSelected,
  onSelectItem,
  buildDragPillPayload,
}: {
  item: FlattenedTreeNode<DiffFileNavigationTreeNode<TFile>>;
  isSelected: boolean;
  onSelectItem: (item: DiffFileNavigationItem<TFile>) => void;
  buildDragPillPayload: (
    item: DiffFileNavigationItem<TFile>
  ) => TabDragPillPayload | null;
}) {
  const { item: navigationItem, rowNode } = item.node;
  const entryIds = navigationItem.entryIds ?? [];
  const { dragHandlers, dragState } = useReferencePillDrag<HTMLDivElement>({
    enabled: Boolean(buildDragPillPayload(navigationItem)),
    tabId: `diff-file:${navigationItem.key}`,
    getPayload: () => buildDragPillPayload(navigationItem),
    getEventDetail: (payload) => ({
      filePath: payload.path,
      name: payload.name,
      type: "file",
    }),
  });

  return (
    <>
      {dragState && <ReferenceDragGhost dragState={dragState} />}
      <TreeRowBase
        node={rowNode}
        depth={item.depth}
        isSelected={isSelected}
        onClick={() => onSelectItem(navigationItem)}
        dataPath={entryIds[entryIds.length - 1] ?? rowNode.id}
        {...dragHandlers}
      />
    </>
  );
}

function DiffFileNavigationListInner<TFile extends DiffFileSectionData>({
  items,
  selectedEntryId,
  selectedPath,
  onSelectItem,
  emptyTitle,
  enableDragToInput = false,
}: DiffFileNavigationListProps<TFile>) {
  const { t } = useTranslation("sessions");
  const resolvedEmptyTitle =
    emptyTitle ??
    t(
      "simulator.replay.diffApp.emptyForFilter",
      "No diffs match this filter yet"
    );

  const flattenedNodes = useMemo(() => items.map(buildTreeNode), [items]);
  const buildDragPillPayload = useCallback(
    (
      navigationItem: DiffFileNavigationItem<TFile>
    ): TabDragPillPayload | null => {
      const filePath = navigationItem.file.path;
      if (!enableDragToInput || !filePath) return null;
      return {
        path: filePath,
        name: getFileName(filePath),
        iconType: "file",
        isFolder: false,
      };
    },
    [enableDragToInput]
  );

  const renderItem = useCallback(
    (item: FlattenedTreeNode<DiffFileNavigationTreeNode<TFile>>) => {
      const { item: navigationItem } = item.node;
      const entryIds = navigationItem.entryIds ?? [];
      const isSelected = selectedEntryId
        ? entryIds.includes(selectedEntryId)
        : selectedPath === navigationItem.file.path;

      return (
        <DiffNavigationRow
          item={item}
          isSelected={isSelected}
          onSelectItem={onSelectItem}
          buildDragPillPayload={buildDragPillPayload}
        />
      );
    },
    [buildDragPillPayload, onSelectItem, selectedEntryId, selectedPath]
  );

  if (items.length === 0) {
    return (
      <Placeholder
        variant="empty"
        placement="sidebar"
        title={resolvedEmptyTitle}
        fillParentHeight
      />
    );
  }

  return (
    <VirtualizedStickyTree
      flattenedNodes={flattenedNodes}
      rowHeight={TREE_ROW_HEIGHT}
      renderItem={renderItem}
      emptyMessage={resolvedEmptyTitle}
    />
  );
}

const DiffFileNavigationList = memo(
  DiffFileNavigationListInner
) as typeof DiffFileNavigationListInner;

export default DiffFileNavigationList;
