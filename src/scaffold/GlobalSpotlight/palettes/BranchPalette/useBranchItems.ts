/**
 * useBranchItems Hook
 *
 * Generates the SpotlightItem list for the branch selector based on current mode.
 */
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import type { BranchItem, SpotlightItem } from "../../types";
import { categorizeBranches } from "../../utils/branchUtils";
import { BRANCH_PALETTE_CONFIG, getIcon, getLabel } from "../config";
import { getManageableBranches } from "./branchManagement";
import type { UseBranchItemsOptions } from "./types";

// Get icons from centralized config
const ICONS = {
  branch: getIcon(BRANCH_PALETTE_CONFIG, "branch")!,
  worktree: getIcon(BRANCH_PALETTE_CONFIG, "worktree")!,
  create: getIcon(BRANCH_PALETTE_CONFIG, "create")!,
  createFrom: getIcon(BRANCH_PALETTE_CONFIG, "createFrom")!,
  delete: getIcon(BRANCH_PALETTE_CONFIG, "delete")!,
  detached: getIcon(BRANCH_PALETTE_CONFIG, "detached")!,
};

export function useBranchItems(
  options: UseBranchItemsOptions
): SpotlightItem[] {
  const { t } = useTranslation();

  const {
    activeMode,
    branches,
    filteredBranches,
    searchQuery,
    currentBranchName,
    onSelect,
    onCreateBranch,
    onClose,
    setActiveMode,
    setSelectedStartPoint,
    focusInput,
    selectedBranchNames,
    toggleBranchSelection,
    renderBranchDeleteAction,
  } = options;

  const labels = useMemo(
    () => ({
      otherBranches:
        t("selectors.branch.labels.otherBranches") ||
        getLabel(BRANCH_PALETTE_CONFIG, "otherBranches"),
      current: t("selectors.branch.labels.current"),
      recent: t("selectors.branch.labels.recent"),
      currentCommit: t("selectors.branch.labels.currentCommit"),
    }),
    [t]
  );

  return useMemo((): SpotlightItem[] => {
    const result: SpotlightItem[] = [];
    // Helper to create branch item
    const createBranchItem = (branch: BranchItem): SpotlightItem => {
      const lastCommit = branch.lastCommitDate
        ? formatRelativeTime(branch.lastCommitDate, "short")
        : "";

      return {
        id: branch.name,
        label: branch.name,
        desc: undefined,
        icon: branch.worktreePath ? ICONS.worktree : ICONS.branch,
        type: "branch" as const,
        data: {
          ...branch,
          isSelector: true,
          isCurrentSelection: branch.name === currentBranchName,
          contextMenuCopy: { name: branch.name },
          tagLabel: branch.isCurrent ? labels.current : undefined,
          rightLabel: lastCommit,
        },
        action: async () => {
          const shouldClose = await onSelect(branch.name, branch);
          if (shouldClose !== false) onClose();
        },
      };
    };

    // Action items (create new branch inline shortcut — only when user is
    // actively typing something that looks like a branch name)
    if (activeMode === "checkout" && searchQuery.trim() && onCreateBranch) {
      result.push({
        id: "__action_create_branch__",
        label: t("selectors.branch.actions.createNewWithName", {
          name: searchQuery.trim(),
        }),
        desc: undefined,
        icon: ICONS.create,
        type: "option" as const,
        data: { isActionItem: true, isSelector: true },
        action: async () => {
          await onCreateBranch(searchQuery.trim());
          onClose();
        },
      });
    }

    // --- Branch list based on mode ---

    if (activeMode === "remove") {
      const deletableBranches = getManageableBranches(filteredBranches);

      if (deletableBranches.length > 0) {
        result.push({
          id: "__header_delete_branches__",
          label: t("selectors.branch.labels.otherBranches"),
          desc: "",
          icon: "",
          type: "option" as const,
          data: { isHeader: true },
          action: () => {},
        });
      }

      deletableBranches.forEach((branch) => {
        const lastCommit = branch.lastCommitDate
          ? formatRelativeTime(branch.lastCommitDate, "short")
          : "";
        result.push({
          id: `delete_${branch.name}`,
          label: branch.name,
          desc: undefined,
          icon: ICONS.branch,
          type: "branch" as const,
          data: {
            ...branch,
            isSelector: true,
            contextMenuCopy: { name: branch.name },
            rightLabel: lastCommit,
            rightContent: renderBranchDeleteAction?.(branch),
            selectionState: {
              checked: selectedBranchNames.has(branch.name),
              onToggle: () => toggleBranchSelection(branch.name),
            },
          },
          action: () => {
            toggleBranchSelection(branch.name);
          },
        });
      });
      return result;
    }

    // Add mode: just show action items (return early)
    if (activeMode === "add") {
      return result;
    }

    // Add-from mode: show ONLY refs (no action items)
    if (activeMode === "add-from") {
      const refList: SpotlightItem[] = [];

      // HEAD option
      refList.push({
        id: "__ref_HEAD__",
        label: "HEAD",
        desc: labels.currentCommit,
        icon: ICONS.branch,
        type: "option" as const,
        data: { isSelector: true, isRef: true },
        action: () => {
          setSelectedStartPoint("HEAD");
          setActiveMode("add");
          setTimeout(focusInput, 50);
        },
      });

      // Branches
      const branchesToShow = searchQuery ? filteredBranches : branches;
      branchesToShow.forEach((branch) => {
        const lastCommit = branch.lastCommitDate
          ? formatRelativeTime(branch.lastCommitDate, "short")
          : "";

        refList.push({
          id: `__ref_${branch.name}__`,
          label: branch.name,
          desc: undefined,
          icon: branch.worktreePath ? ICONS.worktree : ICONS.branch,
          type: "option" as const,
          data: {
            ...branch,
            isSelector: true,
            isRef: true,
            contextMenuCopy: { name: branch.name },
            rightLabel: lastCommit,
          },
          action: () => {
            setSelectedStartPoint(branch.name);
            setActiveMode("add");
            setTimeout(focusInput, 50);
          },
        });
      });

      return refList;
    }

    // Checkout mode: show categorized branches with headers, including during search.
    // Worktree branches are excluded here — they have their own dedicated
    // switcher (WorktreePalette), so listing them again would be redundant.
    const categorized = categorizeBranches(
      filteredBranches.filter((branch) => !branch.worktreePath)
    );

    if (categorized.recent.length > 0) {
      result.push({
        id: "__header_recent__",
        label: labels.recent,
        desc: "",
        icon: "",
        type: "option" as const,
        data: { isHeader: true },
        action: () => {},
      });
      categorized.recent.forEach((branch) => {
        result.push(createBranchItem(branch));
      });
    }

    // Other branches
    if (categorized.other.length > 0 || categorized.default.length > 0) {
      result.push({
        id: "__header_other__",
        label: labels.otherBranches,
        desc: "",
        icon: "",
        type: "option" as const,
        data: { isHeader: true },
        action: () => {},
      });
      // Default branches (main/master/develop/dev) above the alphabetical
      // tail so they're still findable without scrolling all the way.
      categorized.default.forEach((branch) => {
        result.push(createBranchItem(branch));
      });
      categorized.other.forEach((branch) => {
        result.push(createBranchItem(branch));
      });
    }

    return result;
  }, [
    activeMode,
    branches,
    filteredBranches,
    searchQuery,
    currentBranchName,
    onSelect,
    onClose,
    onCreateBranch,
    setActiveMode,
    setSelectedStartPoint,
    focusInput,
    selectedBranchNames,
    toggleBranchSelection,
    renderBranchDeleteAction,
    labels,
    t,
  ]);
}
