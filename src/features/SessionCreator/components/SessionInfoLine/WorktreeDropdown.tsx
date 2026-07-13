import { Check, GitBranch, GitFork, Search } from "lucide-react";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { type GitWorktreeEntry, getGitWorktrees } from "@src/api/http/git";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import {
  type UseDropdownListNavigationReturn,
  useDropdownEngine,
} from "@src/hooks/dropdown";
import { useTauriSelectAllShortcut } from "@src/hooks/keyboard";
import { getViewportSize } from "@src/util/ui/window/viewport";

import { getWorktreeName, normalizeWorktreePath } from "./worktreeSwitcher";

const LIST_MAX_HEIGHT = 360;
const VIEWPORT_MARGIN = 12;
const MIN_DROPDOWN_WIDTH = 320;

interface WorktreeRowProps {
  worktree: GitWorktreeEntry;
  isSelected: boolean;
  mainLabel: string;
  keyboardProps: ReturnType<UseDropdownListNavigationReturn["getItemProps"]>;
}

const WorktreeRow: React.FC<WorktreeRowProps> = ({
  worktree,
  isSelected,
  mainLabel,
  keyboardProps,
}) => (
  <button
    type="button"
    data-testid={`worktree-dropdown-row-${worktree.path}`}
    {...keyboardProps}
    className={`${DROPDOWN_CLASSES.item} ${
      isSelected ? DROPDOWN_CLASSES.itemSelected : DROPDOWN_CLASSES.itemHover
    } w-full justify-start`}
  >
    <span className="flex h-5 w-5 shrink-0 items-center justify-center">
      {isSelected ? (
        <Check size={DROPDOWN_ITEM.iconSize} className="text-primary-6" />
      ) : (
        <GitFork size={DROPDOWN_ITEM.iconSize} className="text-text-2" />
      )}
    </span>
    <div className="flex min-w-0 flex-1 flex-col items-start">
      <span className="truncate">
        {worktree.is_main ? mainLabel : getWorktreeName(worktree)}
      </span>
      <span className="flex max-w-full items-center gap-1 text-[11px] text-text-3">
        <GitBranch size={11} className="shrink-0" />
        <span className="truncate">
          {worktree.branch || worktree.head_sha.slice(0, 7)}
        </span>
      </span>
    </div>
  </button>
);

export interface WorktreeDropdownProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (worktree: GitWorktreeEntry) => void;
  worktrees: readonly GitWorktreeEntry[];
  selectedPath: string;
  anchorRef: React.RefObject<HTMLElement | null>;
}

export function useRepoWorktrees(options: {
  repoId?: string;
  repoPath?: string;
  enabled: boolean;
}): GitWorktreeEntry[] {
  const { repoId, repoPath, enabled } = options;
  const requestKey =
    enabled && repoId && repoPath ? `${repoId}:${repoPath}` : "";
  const [result, setResult] = useState<{
    key: string;
    worktrees: GitWorktreeEntry[];
  }>({ key: "", worktrees: [] });

  useEffect(() => {
    if (!requestKey || !repoId || !repoPath) return;

    let cancelled = false;
    void getGitWorktrees({ repo_id: repoId, repo_path: repoPath })
      .then((entries) => {
        if (!cancelled) setResult({ key: requestKey, worktrees: entries });
      })
      .catch(() => {
        if (!cancelled) setResult({ key: requestKey, worktrees: [] });
      });

    return () => {
      cancelled = true;
    };
  }, [repoId, repoPath, requestKey]);

  return result.key === requestKey ? result.worktrees : [];
}

export const WorktreeDropdown: React.FC<WorktreeDropdownProps> = ({
  isOpen,
  onClose,
  onSelect,
  worktrees,
  selectedPath,
  anchorRef,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const tauriSelectAll = useTauriSelectAllShortcut();
  const [searchQuery, setSearchQuery] = useState("");

  const filteredWorktrees = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return [...worktrees];
    return worktrees.filter((worktree) =>
      `${getWorktreeName(worktree)} ${worktree.path} ${worktree.branch}`
        .toLowerCase()
        .includes(query)
    );
  }, [searchQuery, worktrees]);

  const handleSelect = useCallback(
    (worktree: GitWorktreeEntry) => {
      setSearchQuery("");
      onSelect(worktree);
      onClose();
    },
    [onClose, onSelect]
  );

  const { isPositioned, panelRef, panelPosition, keyboard } = useDropdownEngine<
    HTMLElement,
    GitWorktreeEntry
  >({
    open: isOpen,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
    anchorRef,
    placement: "bottom",
    gap: DROPDOWN_PANEL.triggerGap,
    listNavigation: {
      items: filteredWorktrees,
      onSelect: handleSelect,
      initialSelectedIndex: -1,
    },
  });

  useEffect(() => {
    if (!isOpen || !isPositioned) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen, isPositioned]);

  if (!isOpen || !isPositioned) return null;

  const width = Math.max(MIN_DROPDOWN_WIDTH, panelPosition.width);
  const { width: viewportWidth } = getViewportSize();
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(panelPosition.left, viewportWidth - VIEWPORT_MARGIN - width)
  );

  return createPortal(
    <div
      ref={panelRef}
      className={`${DROPDOWN_CLASSES.panel} fixed flex flex-col`}
      style={{
        top: panelPosition.top,
        bottom: panelPosition.bottom,
        left,
        width,
      }}
    >
      <div className={DROPDOWN_CLASSES.searchContainer}>
        <Search
          size={DROPDOWN_ITEM.iconSize}
          className="shrink-0 text-text-3"
        />
        <input
          ref={inputRef}
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          onKeyDown={tauriSelectAll}
          aria-label={t("sourceControl.scope.searchPlaceholder")}
          placeholder={t("sourceControl.scope.searchPlaceholder")}
          className={DROPDOWN_CLASSES.searchInput}
        />
      </div>
      <div
        className={DROPDOWN_CLASSES.optionsContainerOverlay}
        style={{ maxHeight: LIST_MAX_HEIGHT }}
      >
        {filteredWorktrees.length === 0 ? (
          <div className={DROPDOWN_CLASSES.listMessage}>
            {t("selectors.modelSelector.noResults")}
          </div>
        ) : (
          filteredWorktrees.map((worktree, index) => (
            <WorktreeRow
              key={worktree.path}
              worktree={worktree}
              isSelected={
                normalizeWorktreePath(worktree.path) ===
                normalizeWorktreePath(selectedPath)
              }
              mainLabel={t("sourceControl.scope.main")}
              keyboardProps={keyboard.getItemProps(index)}
            />
          ))
        )}
      </div>
    </div>,
    document.body
  );
};
