/**
 * BranchDropdown
 *
 * Anchored, compact variant of `BranchPalette` for the core switch path
 * (checkout an existing branch). Create / Create-from / Delete /
 * detached-HEAD flows are intentionally absent — those remain in the
 * Spotlight variant because they involve nested input modes.
 *
 * Chosen by `general.modelPickerStyle === "dropdown"`. Falls through to
 * `BranchPalette` (Spotlight) otherwise.
 */
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
import { useFilteredItems } from "@src/hooks/search";
import { getViewportSize } from "@src/util/ui/window/viewport";

import type { BranchItem } from "../../types";
import { categorizeBranches } from "../../utils/branchUtils";
import { useBranchFetch } from "./useBranchFetch";
import { useWorktreeMap } from "./useWorktreeMap";

const LIST_MAX_HEIGHT = 360;
const VIEWPORT_MARGIN = 12;
const MIN_DROPDOWN_WIDTH = 280;

interface BranchRowProps {
  branch: BranchItem;
  isCurrent: boolean;
  keyboardProps: ReturnType<UseDropdownListNavigationReturn["getItemProps"]>;
}

const BranchRow: React.FC<BranchRowProps> = ({
  branch,
  isCurrent,
  keyboardProps,
}) => {
  return (
    <button
      type="button"
      data-testid={`branch-dropdown-row-${branch.name}`}
      {...keyboardProps}
      className={`${DROPDOWN_CLASSES.item} ${
        isCurrent ? DROPDOWN_CLASSES.itemSelected : DROPDOWN_CLASSES.itemHover
      } w-full justify-start`}
    >
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        {isCurrent ? (
          <Check size={DROPDOWN_ITEM.iconSize} className="text-primary-6" />
        ) : branch.worktreePath ? (
          <GitFork size={DROPDOWN_ITEM.iconSize} className="text-text-2" />
        ) : (
          <GitBranch size={DROPDOWN_ITEM.iconSize} className="text-text-2" />
        )}
      </span>
      <span className="truncate">{branch.name}</span>
    </button>
  );
};

export interface BranchDropdownProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (branchName: string, branch: BranchItem) => void | Promise<void>;
  repoId: string;
  repoPath?: string;
  currentBranchName?: string;
  githubConnectionId?: string;
  githubRepoFullName?: string;
  /** Element the dropdown is anchored to. */
  anchorRef: React.RefObject<HTMLElement | null>;
}

export const BranchDropdown: React.FC<BranchDropdownProps> = ({
  isOpen,
  onClose,
  onSelect,
  repoId,
  repoPath,
  currentBranchName,
  githubConnectionId,
  githubRepoFullName,
  anchorRef,
}) => {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const tauriSelectAll = useTauriSelectAllShortcut();

  const [searchQuery, setSearchQuery] = useState("");
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (isOpen !== prevIsOpen) {
    setPrevIsOpen(isOpen);
    if (!isOpen && searchQuery) setSearchQuery("");
  }

  const isGitHubRepo = Boolean(githubConnectionId && githubRepoFullName);

  const { branches: rawBranches, isLoading } = useBranchFetch({
    isOpen,
    repoId,
    repoPath: repoPath || "",
    isGitHubRepo,
    githubConnectionId,
    githubRepoFullName,
  });

  const worktreeMap = useWorktreeMap({
    enabled: isOpen,
    repoId,
    repoPath,
    isLocalRepo: !isGitHubRepo,
  });

  // Merge worktreePath onto each BranchItem so categorizeBranches() can
  // bucket them. Stable identity when there are no worktrees so we don't
  // thrash downstream filters.
  const branches = useMemo(() => {
    if (worktreeMap.size === 0) return rawBranches;
    return rawBranches.map((branch) => {
      const worktreePath = worktreeMap.get(branch.name);
      if (!worktreePath) return branch;
      return { ...branch, worktreePath };
    });
  }, [rawBranches, worktreeMap]);

  const { filteredItems: filteredBranches } = useFilteredItems({
    items: branches,
    searchQuery,
    getSearchText: (branch) => branch.name,
  });

  const sections = useMemo(() => {
    const categorized = categorizeBranches(filteredBranches);
    const result: Array<{
      key: "recent" | "worktrees" | "other";
      label: string | null;
      items: BranchItem[];
    }> = [];
    if (categorized.recent.length > 0) {
      result.push({ key: "recent", label: null, items: categorized.recent });
    }
    if (categorized.worktrees.length > 0) {
      result.push({
        key: "worktrees",
        label: t("selectors.branch.labels.worktrees"),
        items: categorized.worktrees,
      });
    }
    const tail = [...categorized.default, ...categorized.other];
    if (tail.length > 0) {
      result.push({
        key: "other",
        label: t("selectors.branch.labels.otherBranches"),
        items: tail,
      });
    }
    return result;
  }, [filteredBranches, t]);

  const visibleBranches = useMemo(
    () => sections.flatMap((section) => section.items),
    [sections]
  );

  const handleSelect = useCallback(
    async (branch: BranchItem) => {
      await onSelect(branch.name, branch);
      onClose();
    },
    [onSelect, onClose]
  );

  const { isPositioned, panelRef, panelPosition, keyboard } = useDropdownEngine<
    HTMLElement,
    BranchItem
  >({
    open: isOpen,
    onOpenChange: (open) => {
      if (!open) onClose();
    },
    anchorRef,
    placement: "bottom",
    gap: DROPDOWN_PANEL.triggerGap,
    listNavigation: {
      items: visibleBranches,
      onSelect: handleSelect,
      initialSelectedIndex: -1,
    },
  });

  useEffect(() => {
    if (!isOpen || !isPositioned) return;
    const frame = requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [isOpen, isPositioned]);

  if (!isOpen || !isPositioned) return null;

  const width = Math.max(MIN_DROPDOWN_WIDTH, panelPosition.width);
  const { width: vw } = getViewportSize();
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(panelPosition.left, vw - VIEWPORT_MARGIN - width)
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
          placeholder={t("selectors.spotlight.placeholders.branch")}
          className={DROPDOWN_CLASSES.searchInput}
        />
      </div>

      <div
        className={DROPDOWN_CLASSES.optionsContainerOverlay}
        style={{ maxHeight: LIST_MAX_HEIGHT }}
      >
        {isLoading && filteredBranches.length === 0 ? (
          <div className={DROPDOWN_CLASSES.listMessage}>
            {t("status.loading")}
          </div>
        ) : filteredBranches.length === 0 ? (
          <div className={DROPDOWN_CLASSES.listMessage}>
            {t("selectors.modelSelector.noResults")}
          </div>
        ) : (
          sections.map((section) => (
            <React.Fragment key={section.key}>
              {section.label && (
                <div className={DROPDOWN_CLASSES.sectionLabel}>
                  {section.label}
                </div>
              )}
              {section.items.map((branch) => {
                const index = visibleBranches.findIndex(
                  (visibleBranch) => visibleBranch.name === branch.name
                );
                return (
                  <BranchRow
                    key={branch.name}
                    branch={branch}
                    isCurrent={branch.name === currentBranchName}
                    keyboardProps={keyboard.getItemProps(index)}
                  />
                );
              })}
            </React.Fragment>
          ))
        )}
      </div>
    </div>,
    document.body
  );
};

BranchDropdown.displayName = "BranchDropdown";
