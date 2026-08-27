/**
 * WorkStation useFileTreeMutationState
 *
 * Encapsulates all file-tree mutation state:
 * - Inline rename (F2 / Enter, Backspace/Delete keyboard shortcuts)
 * - VS Code-style new file/folder creation via inline placeholder
 * - Placeholder insertion into the flattened node list
 * - Scroll-to-placeholder after insertion
 */
import {
  type KeyboardEvent,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { VirtuosoHandle } from "react-virtuoso";

import type { TreePanelNode } from "@src/components/TreePanelSidebar/types";
import type { FlattenedTreeNode } from "@src/components/VirtualizedStickyTree";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import type { CreatingNewState, DispatchFn, FlattenedNode } from "./types";

export const NEW_ITEM_PLACEHOLDER_ID = "__new_item_placeholder__";

export interface UseFileTreeMutationStateOptions {
  selectedPath: string | null;
  baseFlattenedNodes: FlattenedNode[];
  onToggleDirectory: (path: string) => void;
  dispatch: DispatchFn;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
}

export interface UseFileTreeMutationStateReturn {
  renamingPath: string | null;
  creatingNew: CreatingNewState | null;
  flattenedNodes: FlattenedNode[];
  handleStartRename: (path: string) => void;
  handleRenameConfirm: (oldPath: string, newName: string) => Promise<void>;
  handleRenameCancel: () => void;
  handleStartCreateNew: (parentDir: string, isFolder: boolean) => void;
  handleCreateNewConfirm: (name: string) => Promise<void>;
  handleCreateNewCancel: () => void;
  handleKeyDown: (event: KeyboardEvent) => Promise<void>;
}

function getPlaceholderInsertion(
  nodes: FlattenedNode[],
  creatingNew: CreatingNewState
): { insertIndex: number; parentDepth: number } {
  const { parentDir, isFolder } = creatingNew;
  let parentIndex = -1;
  let parentDepth = 0;

  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const node = nodes[nodeIndex];
    if (node.node.path === parentDir && node.node.type === "directory") {
      parentIndex = nodeIndex;
      parentDepth = node.depth + 1;
      break;
    }
  }

  if (parentIndex === -1) {
    if (isFolder) {
      return { insertIndex: 0, parentDepth: 0 };
    }

    let rootFileInsertIndex = 0;
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
      const node = nodes[nodeIndex];
      if (node.depth === 0 && node.node.type === "directory") {
        rootFileInsertIndex = nodeIndex + 1;
        while (
          rootFileInsertIndex < nodes.length &&
          nodes[rootFileInsertIndex].depth > 0
        ) {
          rootFileInsertIndex++;
        }
      } else if (node.depth === 0) {
        break;
      }
    }
    return { insertIndex: rootFileInsertIndex, parentDepth: 0 };
  }

  if (isFolder) {
    return { insertIndex: parentIndex + 1, parentDepth };
  }

  let fileInsertIndex = parentIndex + 1;
  while (fileInsertIndex < nodes.length) {
    const node = nodes[fileInsertIndex];
    if (node.depth < parentDepth) break;
    if (node.depth > parentDepth) {
      fileInsertIndex++;
      continue;
    }
    if (node.node.type === "directory") {
      fileInsertIndex++;
    } else {
      break;
    }
  }

  return { insertIndex: fileInsertIndex, parentDepth };
}

function insertNewItemPlaceholder(
  baseFlattenedNodes: FlattenedNode[],
  creatingNew: CreatingNewState | null
): FlattenedNode[] {
  if (!creatingNew) return baseFlattenedNodes;

  const nodes = [...baseFlattenedNodes];
  const { insertIndex, parentDepth } = getPlaceholderInsertion(
    nodes,
    creatingNew
  );
  const placeholderNode: FlattenedTreeNode<TreePanelNode> = {
    node: {
      id: NEW_ITEM_PLACEHOLDER_ID,
      name: "",
      path: NEW_ITEM_PLACEHOLDER_ID,
      type: creatingNew.isFolder ? "directory" : "file",
      expanded: false,
    },
    depth: parentDepth,
  };

  nodes.splice(insertIndex, 0, placeholderNode);
  return nodes;
}

export function useFileTreeMutationState({
  selectedPath,
  baseFlattenedNodes,
  onToggleDirectory,
  dispatch,
  virtuosoRef,
}: UseFileTreeMutationStateOptions): UseFileTreeMutationStateReturn {
  const { t } = useTranslation();
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState<CreatingNewState | null>(null);
  const pendingScrollToPlaceholderRef = useRef(false);

  const handleStartRename = useCallback((path: string) => {
    setRenamingPath(path);
  }, []);

  const handleRenameConfirm = useCallback(
    async (oldPath: string, newName: string) => {
      const parentDir = oldPath.substring(0, oldPath.lastIndexOf("/"));
      const newPath = `${parentDir}/${newName}`;
      await dispatch("file.rename", { oldPath, newPath }, "user");
      setRenamingPath(null);
    },
    [dispatch]
  );

  const handleRenameCancel = useCallback(() => {
    setRenamingPath(null);
  }, []);

  const handleCreateNewConfirm = useCallback(
    async (name: string) => {
      if (!creatingNew || !name.trim()) {
        setCreatingNew(null);
        return;
      }
      const fullPath = `${creatingNew.parentDir}/${name.trim()}`;
      if (creatingNew.isFolder) {
        await dispatch("folder.create", { path: fullPath }, "user");
      } else {
        await dispatch("file.create", { path: fullPath, content: "" }, "user");
      }
      setCreatingNew(null);
    },
    [creatingNew, dispatch]
  );

  const handleCreateNewCancel = useCallback(() => {
    setCreatingNew(null);
  }, []);

  const flattenedNodes = useMemo(
    () => insertNewItemPlaceholder(baseFlattenedNodes, creatingNew),
    [baseFlattenedNodes, creatingNew]
  );

  const handleStartCreateNew = useCallback(
    (parentDir: string, isFolder: boolean) => {
      const parentNode = baseFlattenedNodes.find(
        (node) => node.node.path === parentDir && node.node.type === "directory"
      );
      if (parentNode && !parentNode.node.expanded) {
        onToggleDirectory(parentDir);
      }
      setCreatingNew({ parentDir, isFolder });
      pendingScrollToPlaceholderRef.current = true;
    },
    [baseFlattenedNodes, onToggleDirectory]
  );

  useEffect(() => {
    if (!pendingScrollToPlaceholderRef.current || !creatingNew) return;
    pendingScrollToPlaceholderRef.current = false;

    const placeholderIndex = flattenedNodes.findIndex(
      (node) => node.node.path === NEW_ITEM_PLACEHOLDER_ID
    );

    if (placeholderIndex >= 0 && virtuosoRef.current) {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: placeholderIndex,
          align: "center",
          behavior: "smooth",
        });
      });
    }
  }, [creatingNew, flattenedNodes, virtuosoRef]);

  const handleKeyDown = useCallback(
    async (event: KeyboardEvent) => {
      if (!selectedPath || renamingPath) return;

      switch (event.key) {
        case "F2":
        case "Enter":
          event.preventDefault();
          setRenamingPath(selectedPath);
          break;
        case "Delete":
        case "Backspace":
          if (event.metaKey || event.ctrlKey) {
            event.preventDefault();
            const fileName = selectedPath.split("/").pop() || "";
            const confirmed = await confirmDestructiveAction({
              title: t("actions.confirmDeleteTitle", { name: fileName }),
              message: t("confirmation.delete"),
              okLabel: t("actions.delete"),
              cancelLabel: t("actions.cancel"),
            });
            if (!confirmed) break;
            dispatch("file.delete", { path: selectedPath }, "user");
          }
          break;
      }
    },
    [selectedPath, renamingPath, dispatch, t]
  );

  return {
    renamingPath,
    creatingNew,
    flattenedNodes,
    handleStartRename,
    handleRenameConfirm,
    handleRenameCancel,
    handleStartCreateNew,
    handleCreateNewConfirm,
    handleCreateNewCancel,
    handleKeyDown,
  };
}
