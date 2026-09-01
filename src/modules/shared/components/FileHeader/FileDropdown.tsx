/**
 * FileDropdown Component
 *
 * VS Code-like tree dropdown for breadcrumb navigation.
 * Uses TreeRowBase for consistent explorer styling with git status markers.
 * Folders are expandable (lazy-loaded via readDir) with sticky headers.
 * Files are selectable (opens new tab via onFileSelect callback).
 */
import { readDir } from "@tauri-apps/plugin-fs";
import { useAtomValue } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { Placeholder } from "@src/components/Placeholder";
import {
  GitStatusBadge,
  TREE_ROW_HEIGHT,
  TreeRowBase,
} from "@src/components/TreeRow";
import type { GitStatusInfo, TreeRowNode } from "@src/components/TreeRow";
import {
  gitFileStatusMapAtom,
  gitFolderStatusMapAtom,
} from "@src/store/git/gitStatusAtom";
import { getViewportSize } from "@src/util/ui/window/viewport";

import { calculateFileDropdownPosition } from "./fileDropdownPosition";

// ============================================
// Types
// ============================================

interface TreeEntry {
  path: string;
  name: string;
  type: "file" | "directory";
  expanded: boolean;
  loaded: boolean;
  children: TreeEntry[];
}

export interface FileDropdownProps {
  visible: boolean;
  directoryPath: string | null;
  repoPath?: string;
  currentFilePath: string;
  onFileSelect: (filePath: string) => void;
  onClose: () => void;
  triggerRef?: React.RefObject<HTMLElement | null>;
}

// ============================================
// Helpers
// ============================================

async function loadChildren(dirPath: string): Promise<TreeEntry[]> {
  const entries = await readDir(dirPath);
  const nodes: TreeEntry[] = entries
    .filter((entry) => entry.name)
    .map((entry) => ({
      path: `${dirPath}/${entry.name}`,
      name: entry.name || "",
      type: entry.isDirectory ? ("directory" as const) : ("file" as const),
      expanded: false,
      loaded: false,
      children: [],
    }));

  nodes.sort((nodeA, nodeB) => {
    if (nodeA.type !== nodeB.type) return nodeA.type === "directory" ? -1 : 1;
    return nodeA.name.localeCompare(nodeB.name);
  });

  return nodes;
}

interface FlatRow {
  entry: TreeEntry;
  depth: number;
}

function flattenEntries(entries: TreeEntry[], depth = 0): FlatRow[] {
  const rows: FlatRow[] = [];
  for (const entry of entries) {
    rows.push({ entry, depth });
    if (entry.type === "directory" && entry.expanded) {
      rows.push(...flattenEntries(entry.children, depth + 1));
    }
  }
  return rows;
}

function updateEntry(
  entries: TreeEntry[],
  targetPath: string,
  updater: (entry: TreeEntry) => TreeEntry
): TreeEntry[] {
  return entries.map((entry) => {
    if (entry.path === targetPath) return updater(entry);
    if (entry.type === "directory" && entry.children.length > 0) {
      return {
        ...entry,
        children: updateEntry(entry.children, targetPath, updater),
      };
    }
    return entry;
  });
}

function getRelativePath(absolutePath: string, repoPath?: string): string {
  if (!repoPath || !absolutePath.startsWith(repoPath)) return absolutePath;
  return absolutePath.substring(repoPath.length + 1);
}

// ============================================
// Component
// ============================================

const MAX_VISIBLE_ROWS = 14;
const FILE_TREE_DROPDOWN_WIDTH = 280;
const VIEWPORT_MARGIN = 8;

interface LoadedEntries {
  key: string;
  entries: TreeEntry[];
}

const FileDropdown: React.FC<FileDropdownProps> = ({
  visible,
  directoryPath,
  repoPath,
  currentFilePath,
  onFileSelect,
  onClose,
  triggerRef,
}) => {
  const { t } = useTranslation();
  const dropdownRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ top: 0, left: 0 });
  const [isPositioned, setIsPositioned] = useState(false);
  const [loadedEntries, setLoadedEntries] = useState<LoadedEntries | null>(
    null
  );
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  const gitFileStatusMap = useAtomValue(gitFileStatusMapAtom);
  const gitFolderStatusMap = useAtomValue(gitFolderStatusMapAtom);

  // Position
  const updatePosition = useCallback(() => {
    if (!triggerRef?.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const { width: vw, height: vh } = getViewportSize();
    setPosition(
      calculateFileDropdownPosition({
        triggerRect: rect,
        viewportWidth: vw,
        viewportHeight: vh,
        dropdownWidth: FILE_TREE_DROPDOWN_WIDTH,
        dropdownMaxHeight: MAX_VISIBLE_ROWS * TREE_ROW_HEIGHT,
        viewportMargin: VIEWPORT_MARGIN,
        triggerGap: DROPDOWN_PANEL.triggerGapTight,
      })
    );
    setIsPositioned(true);
  }, [triggerRef]);

  useEffect(() => {
    if (!visible) {
      const timer = setTimeout(() => setIsPositioned(false), 0);
      return () => clearTimeout(timer);
    }
    updatePosition();
    window.addEventListener("scroll", updatePosition, true);
    window.addEventListener("resize", updatePosition);
    return () => {
      window.removeEventListener("scroll", updatePosition, true);
      window.removeEventListener("resize", updatePosition);
    };
  }, [visible, updatePosition]);

  const rootEntries = useMemo(
    () =>
      visible && directoryPath && loadedEntries?.key === directoryPath
        ? loadedEntries.entries
        : [],
    [visible, directoryPath, loadedEntries]
  );

  const rootLoading = visible && !!directoryPath && loadedKey !== directoryPath;

  const setRootEntries = useCallback(
    (entriesOrUpdater: TreeEntry[] | ((prev: TreeEntry[]) => TreeEntry[])) => {
      if (!directoryPath) return;
      setLoadedEntries((prev) => {
        const currentEntries = prev?.key === directoryPath ? prev.entries : [];
        const nextEntries =
          typeof entriesOrUpdater === "function"
            ? entriesOrUpdater(currentEntries)
            : entriesOrUpdater;
        return { key: directoryPath, entries: nextEntries };
      });
    },
    [directoryPath]
  );

  // Load root
  useEffect(() => {
    if (!visible || !directoryPath) return;
    let cancelled = false;
    loadChildren(directoryPath)
      .then((nodes) => {
        if (!cancelled) {
          setLoadedEntries({ key: directoryPath, entries: nodes });
          setLoadedKey(directoryPath);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLoadedEntries({ key: directoryPath, entries: [] });
          setLoadedKey(directoryPath);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [visible, directoryPath]);

  // Click outside
  useEffect(() => {
    if (!visible) return;
    const handler = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        triggerRef?.current &&
        !triggerRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [visible, onClose, triggerRef]);

  // ESC
  useEffect(() => {
    if (!visible) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [visible, onClose]);

  // Toggle folder
  const handleToggle = useCallback(
    async (entryPath: string) => {
      setRootEntries((prev) => {
        const flat = flattenEntries(prev);
        const target = flat.find((row) => row.entry.path === entryPath)?.entry;
        if (!target || target.type !== "directory") return prev;

        if (target.expanded) {
          return updateEntry(prev, entryPath, (existing) => ({
            ...existing,
            expanded: false,
          }));
        }

        if (!target.loaded) {
          loadChildren(entryPath).then((children) => {
            setRootEntries((current) =>
              updateEntry(current, entryPath, (existing) => ({
                ...existing,
                expanded: true,
                loaded: true,
                children,
              }))
            );
          });
          return prev;
        }

        return updateEntry(prev, entryPath, (existing) => ({
          ...existing,
          expanded: true,
        }));
      });
    },
    [setRootEntries]
  );

  // Row click
  const handleRowClick = useCallback(
    (entry: TreeEntry) => {
      if (entry.type === "file") {
        onFileSelect(entry.path);
      } else {
        handleToggle(entry.path);
      }
    },
    [onFileSelect, handleToggle]
  );

  // Git status lookup for a row
  const getGitStatus = useCallback(
    (entry: TreeEntry): GitStatusInfo | null => {
      const relativePath = getRelativePath(entry.path, repoPath);
      if (entry.type === "directory") {
        const folderStatus = gitFolderStatusMap.get(relativePath);
        return folderStatus ? { status: folderStatus, staged: false } : null;
      }
      const fileInfo = gitFileStatusMap.get(relativePath);
      return fileInfo
        ? { status: fileInfo.status, staged: fileInfo.staged }
        : null;
    },
    [repoPath, gitFileStatusMap, gitFolderStatusMap]
  );

  // Find sticky folder ancestors for current scroll position
  const flatRows = useMemo(() => flattenEntries(rootEntries), [rootEntries]);

  // Track sticky folders (expanded folders that have scrolled past)
  const [stickyFolders, setStickyFolders] = useState<FlatRow[]>([]);

  const handleScroll = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;

    const scrollTop = container.scrollTop;
    const visibleTopIndex = Math.floor(scrollTop / TREE_ROW_HEIGHT);

    const stickies: FlatRow[] = [];
    for (let idx = 0; idx < visibleTopIndex && idx < flatRows.length; idx++) {
      const row = flatRows[idx];
      if (row.entry.type === "directory" && row.entry.expanded) {
        const folderEndIdx = findFolderEndIndex(flatRows, idx);
        if (folderEndIdx > visibleTopIndex) {
          while (
            stickies.length > 0 &&
            stickies[stickies.length - 1].depth >= row.depth
          ) {
            stickies.pop();
          }
          stickies.push(row);
        }
      }
    }

    setStickyFolders(stickies);
  }, [flatRows]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    container.addEventListener("scroll", handleScroll);
    return () => container.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  if (!visible || !isPositioned) return null;

  const needsScroll = flatRows.length > MAX_VISIBLE_ROWS;
  const listMaxHeight = MAX_VISIBLE_ROWS * TREE_ROW_HEIGHT;
  const stickyHeight = stickyFolders.length * TREE_ROW_HEIGHT;

  return createPortal(
    <div
      ref={dropdownRef}
      className={`${DROPDOWN_CLASSES.menuPanelBase} fixed ${DROPDOWN_WIDTHS.fileTreeClass}`}
      style={{ top: position.top, left: position.left }}
    >
      {rootLoading && <Placeholder variant="loading" />}

      {!rootLoading && flatRows.length === 0 && (
        <Placeholder variant="empty" title={t("placeholders.noFilesFound")} />
      )}

      {!rootLoading && flatRows.length > 0 && (
        <div className="relative">
          {/* Sticky folder headers */}
          {stickyFolders.length > 0 && (
            <div
              className="absolute top-0 right-0 left-0 z-10 bg-bg-2"
              style={{ height: stickyHeight }}
            >
              {stickyFolders.map((row, idx) => (
                <div
                  key={row.entry.path}
                  style={{
                    height: TREE_ROW_HEIGHT,
                    top: idx * TREE_ROW_HEIGHT,
                  }}
                  className="absolute right-0 left-0"
                >
                  <TreeRowBase
                    node={{
                      id: row.entry.path,
                      name: row.entry.name,
                      path: row.entry.path,
                      type: row.entry.type,
                      expanded: row.entry.expanded,
                    }}
                    depth={row.depth}
                    isSelected={false}
                    gitStatus={getGitStatus(row.entry)}
                    onClick={() => handleToggle(row.entry.path)}
                    className="bg-bg-2"
                    showIndentGuides
                    inset={false}
                  >
                    <GitStatusBadge
                      status={getGitStatus(row.entry)}
                      isDirectory={true}
                    />
                  </TreeRowBase>
                </div>
              ))}
            </div>
          )}

          {/* Scrollable list */}
          <div
            ref={scrollRef}
            className={needsScroll ? "scrollbar-hide overflow-y-auto" : ""}
            style={{
              ...(needsScroll ? { maxHeight: listMaxHeight } : {}),
              ...(stickyHeight > 0 ? { paddingTop: stickyHeight } : {}),
            }}
          >
            {flatRows.map((row) => {
              const treeNode: TreeRowNode = {
                id: row.entry.path,
                name: row.entry.name,
                path: row.entry.path,
                type: row.entry.type,
                expanded: row.entry.expanded,
              };
              const isCurrent = row.entry.path === currentFilePath;

              const gitStatus = getGitStatus(row.entry);
              const isDir = row.entry.type === "directory";

              return (
                <TreeRowBase
                  key={row.entry.path}
                  node={treeNode}
                  depth={row.depth}
                  isSelected={isCurrent}
                  gitStatus={gitStatus}
                  onClick={() => handleRowClick(row.entry)}
                  showIndentGuides
                  inset={false}
                >
                  <GitStatusBadge status={gitStatus} isDirectory={isDir} />
                </TreeRowBase>
              );
            })}
          </div>
        </div>
      )}
    </div>,
    document.body
  );
};

/**
 * Find the index of the last descendant of a folder at the given index.
 */
function findFolderEndIndex(rows: FlatRow[], folderIdx: number): number {
  const folderDepth = rows[folderIdx].depth;
  let endIdx = folderIdx + 1;
  while (endIdx < rows.length && rows[endIdx].depth > folderDepth) {
    endIdx++;
  }
  return endIdx - 1;
}

export default FileDropdown;
