/**
 * useBranchPalette Hook
 *
 * Main hook that orchestrates branch palette state and behavior.
 * Uses useSelector for common patterns while adding branch-specific logic.
 */
import {
  Check,
  GitBranchMinus,
  GitBranchPlus,
  Split,
  Trash2,
} from "lucide-react";
import {
  type Dispatch,
  type KeyboardEvent,
  type MouseEvent,
  type SetStateAction,
  createElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { createLogger } from "@src/hooks/logger";
import { useFilteredItems } from "@src/hooks/search";

import { ICONS } from "../../config";
import type { SpotlightItem } from "../../types";
import {
  BRANCH_PALETTE_CONFIG,
  buildPathSegment,
  getModePath,
} from "../config";
import { useSelectorKernel } from "../core";
import type { BranchPaletteMode, UseBranchPaletteOptions } from "./types";
import { useBranchFetch } from "./useBranchFetch";
import { useBranchItems } from "./useBranchItems";
import { refreshWorktreeMap, useWorktreeMap } from "./useWorktreeMap";

const log = createLogger("useBranchPalette");
const REFRESH_SPIN_MIN_MS = 900;

export function useBranchPalette(options: UseBranchPaletteOptions) {
  const { t } = useTranslation();

  const {
    isOpen,
    repoId,
    repoPathProp,
    currentBranchName,
    onSelect,
    onCreateBranch,
    onDeleteBranch,
    onRemoveWorktree,
    onCheckoutDetached,
    onClose,
    onGoBackToParent,
    variant,
    effectiveShowRemoveMode,
    parentModalState = false,
    githubConnectionId,
    githubRepoFullName,
  } = options;

  // ============ LOCAL STATE ============
  const [searchQuery, setSearchQueryState] = useState("");
  const [activeMode, setActiveMode] = useState<BranchPaletteMode>("checkout");
  const [isCreatingBranch, setIsCreatingBranch] = useState(false);
  const [isRefreshSpinning, setIsRefreshSpinning] = useState(false);
  const [selectedStartPoint, setSelectedStartPoint] = useState<string | null>(
    null
  );
  const [selectedBranchNames, setSelectedBranchNames] = useState<Set<string>>(
    () => new Set()
  );

  // ============ DERIVED STATE ============
  const isGitHubRepo = Boolean(githubConnectionId && githubRepoFullName);
  const hasModalState = parentModalState || activeMode !== "checkout";
  const focusInputRef = useRef<() => void>(() => {});

  const focusInputBridge = useCallback(() => {
    focusInputRef.current();
  }, []);

  // ============ FETCH BRANCHES ============
  const {
    branches: rawBranches,
    isLoading,
    refresh: refreshBranches,
  } = useBranchFetch({
    isOpen,
    repoId,
    repoPath: repoPathProp || "",
    isGitHubRepo,
    githubConnectionId,
    githubRepoFullName,
  });

  const handleRefreshBranches = useCallback(async () => {
    setIsRefreshSpinning(true);
    const startedAt = Date.now();
    try {
      await refreshBranches();
    } finally {
      const elapsed = Date.now() - startedAt;
      const remaining = Math.max(0, REFRESH_SPIN_MIN_MS - elapsed);
      window.setTimeout(() => setIsRefreshSpinning(false), remaining);
    }
  }, [refreshBranches]);

  // ============ FETCH WORKTREES (local repos only) ============
  const worktreeMap = useWorktreeMap({
    enabled: isOpen,
    repoId,
    repoPath: repoPathProp,
    isLocalRepo: !isGitHubRepo,
  });

  // Merge worktreePath onto each BranchItem so categorizeBranches() can
  // bucket them into the Worktrees section.
  const branches = useMemo(() => {
    if (worktreeMap.size === 0) return rawBranches;
    return rawBranches.map((branch) => {
      const worktreePath = worktreeMap.get(branch.name);
      if (!worktreePath) return branch;
      return { ...branch, worktreePath };
    });
  }, [rawBranches, worktreeMap]);

  // ============ FILTERED BRANCHES ============
  const { filteredItems: filteredBranches } = useFilteredItems({
    items: branches,
    searchQuery,
    getSearchText: (branch) => branch.name,
  });

  // ============ GO BACK HANDLER ============
  const handleGoBack = useCallback(() => {
    // From add with startPoint -> go back to add-from
    if (activeMode === "add" && selectedStartPoint) {
      setSelectedStartPoint(null);
      setActiveMode("add-from");
      setSearchQueryState("");
      return;
    }
    // From any sub-level -> go back to checkout
    if (
      activeMode === "add" ||
      activeMode === "add-from" ||
      activeMode === "remove"
    ) {
      setSelectedStartPoint(null);
      setSelectedBranchNames(new Set());
      setActiveMode("checkout");
      setSearchQueryState("");
      return;
    }

    if (parentModalState) {
      if (onGoBackToParent) {
        onGoBackToParent();
        return;
      }
      onClose();
    }
  }, [
    activeMode,
    onClose,
    onGoBackToParent,
    parentModalState,
    selectedStartPoint,
  ]);

  // ============ ITEM SELECTION ============
  const isItemSelectable = useCallback((item: SpotlightItem) => {
    const data = item.data as Record<string, unknown> | undefined;
    return !data?.isHeader && !data?.disabled;
  }, []);

  const toggleBranchSelection = useCallback((branchName: string) => {
    setSelectedBranchNames((prev) => {
      const next = new Set(prev);
      if (next.has(branchName)) {
        next.delete(branchName);
      } else {
        next.add(branchName);
      }
      return next;
    });
  }, []);

  const handleDeleteBranch = useCallback(
    async (branchName: string) => {
      if (!onDeleteBranch) return;
      const result = await onDeleteBranch(branchName, { skipRefresh: true });
      if (result?.success === false) return;
      setSelectedBranchNames((prev) => {
        if (!prev.has(branchName)) return prev;
        const next = new Set(prev);
        next.delete(branchName);
        return next;
      });
      await refreshBranches();
    },
    [onDeleteBranch, refreshBranches]
  );

  const handleRemoveWorktree = useCallback(
    async (worktreePath: string) => {
      if (!onRemoveWorktree) return;
      const result = await onRemoveWorktree(worktreePath, {
        skipRefresh: true,
      });
      if (result?.success === false) return;
      await refreshWorktreeMap(repoId, repoPathProp);
      await refreshBranches();
    },
    [onRemoveWorktree, refreshBranches, repoId, repoPathProp]
  );

  const renderBranchRemoveAction = useCallback(
    (branch: { name: string; worktreePath?: string }) =>
      createElement(
        "button",
        {
          type: "button",
          onClick: (event: MouseEvent<HTMLButtonElement>) => {
            event.stopPropagation();
            if (branch.worktreePath) {
              void handleRemoveWorktree(branch.worktreePath);
              return;
            }
            void handleDeleteBranch(branch.name);
          },
          className:
            "flex items-center justify-center rounded-md p-1 text-text-2 transition-colors hover:bg-fill-3 hover:text-text-1",
          title: branch.worktreePath
            ? t("selectors.branch.actions.removeWorktree", {
                defaultValue: "Remove Worktree",
              })
            : t("actions.delete", "Delete"),
        },
        createElement(Trash2, { size: 14 })
      ),
    [handleDeleteBranch, handleRemoveWorktree, t]
  );

  // ============ ITEMS (needs to be before useSelector) ============
  const mainItems = useBranchItems({
    activeMode,
    branches,
    filteredBranches,
    searchQuery,
    currentBranchName,
    effectiveShowRemoveMode,
    onSelect,
    onCreateBranch,
    onDeleteBranch,
    onRemoveWorktree,
    onCheckoutDetached,
    onClose,
    setActiveMode,
    setSelectedStartPoint,
    focusInput: focusInputBridge,
    selectedBranchNames,
    toggleBranchSelection,
    removeWorktree: handleRemoveWorktree,
    renderBranchRemoveAction,
  });

  const selectedBranchCount = selectedBranchNames.size;

  const handleDeleteSelectedBranches = useCallback(async () => {
    if (!onDeleteBranch || selectedBranchNames.size === 0) return;
    const branchNames = Array.from(selectedBranchNames);
    const failedBranchNames: string[] = [];

    for (const branchName of branchNames) {
      const result = await onDeleteBranch(branchName, {
        silent: true,
        skipRefresh: true,
      });
      if (result?.success === false) {
        failedBranchNames.push(branchName);
      }
    }

    const deletedCount = branchNames.length - failedBranchNames.length;
    const summaryParts = [
      deletedCount > 0
        ? t("selectors.branch.messages.deletedCount", {
            count: deletedCount,
            defaultValue: "Deleted {{count}} branch",
          })
        : null,
      failedBranchNames.length > 0
        ? t("selectors.branch.messages.failedDeleteList", {
            branches: failedBranchNames.join(", "),
            defaultValue: "Failed to delete: {{branches}}",
          })
        : null,
    ].filter(Boolean);

    if (summaryParts.length > 0) {
      const kind = failedBranchNames.length > 0 ? "error" : "info";
      const { showGitActionDialogSafely } =
        await import("@src/util/dialogs/gitActionDialog");
      showGitActionDialogSafely(summaryParts.join("\n"), kind);
    }

    setSelectedBranchNames(new Set(failedBranchNames));
    await refreshBranches();
  }, [onDeleteBranch, refreshBranches, selectedBranchNames, t]);

  const pinnedActionItems = useMemo((): SpotlightItem[] => {
    const actions: SpotlightItem[] = [];

    if (activeMode === "remove") {
      if (selectedBranchCount > 0) {
        actions.push({
          id: "pinned-branch-delete-selected",
          label: `${t("actions.delete", "Delete")} (${selectedBranchCount})`,
          icon: Trash2,
          type: "action",
          action: () => {
            void handleDeleteSelectedBranches();
          },
        });
      }
      actions.push({
        id: "pinned-branch-remove-done",
        label: t("actions.done", "Done"),
        icon: Check,
        type: "action",
        action: () => {
          setSelectedBranchNames(new Set());
          setActiveMode("checkout");
        },
      });
      return actions;
    }

    if (activeMode !== "checkout") return actions;

    if (onCreateBranch) {
      actions.push(
        {
          id: "pinned-branch-create-new",
          label: t("selectors.branch.actions.createNew", "New Branch"),
          icon: GitBranchPlus,
          type: "action",
          data: { showDisclosureChevron: true },
          action: () => setActiveMode("add"),
        },
        {
          id: "pinned-branch-create-from",
          label: t("selectors.branch.actions.createFrom", "New Branch From"),
          icon: Split,
          type: "action",
          data: { showDisclosureChevron: true },
          action: () => {
            setSelectedStartPoint(null);
            setActiveMode("add-from");
          },
        }
      );
    }

    if (effectiveShowRemoveMode && onDeleteBranch) {
      actions.push({
        id: "pinned-branch-delete",
        label: t("selectors.branch.actions.deleteBranch", "Delete Branch"),
        icon: GitBranchMinus,
        type: "action",
        data: { showDisclosureChevron: true },
        action: () => setActiveMode("remove"),
      });
    }

    const RefreshIcon = (props: { size?: number; className?: string }) =>
      createElement(ICONS.refresh, {
        ...props,
        className:
          `${props.className ?? ""} ${isRefreshSpinning ? "spotlight-refresh-spin" : ""}`.trim(),
      });

    actions.push({
      id: "pinned-branch-refresh",
      label: t("selectors.branch.actions.refresh", "Refresh"),
      icon: RefreshIcon,
      type: "action",
      data: {
        disabled: isLoading,
      },
      action: () => void handleRefreshBranches(),
    });

    return actions;
  }, [
    activeMode,
    effectiveShowRemoveMode,
    isLoading,
    onCreateBranch,
    handleDeleteSelectedBranches,
    onDeleteBranch,
    handleRefreshBranches,
    isRefreshSpinning,
    selectedBranchCount,
    t,
  ]);

  const pinnedActionStartIndex = mainItems.length;
  const items = useMemo(
    () =>
      (activeMode === "checkout" || activeMode === "remove") &&
      pinnedActionItems.length > 0
        ? [...mainItems, ...pinnedActionItems]
        : mainItems,
    [activeMode, mainItems, pinnedActionItems]
  );

  const handleSectionTab = useCallback(
    (
      forward: boolean,
      selectedIndex: number,
      setSelectedIndex: Dispatch<SetStateAction<number>>
    ) => {
      if (
        (activeMode !== "checkout" && activeMode !== "remove") ||
        pinnedActionItems.length === 0
      ) {
        return;
      }

      const firstMainItemIndex = mainItems.findIndex(isItemSelectable);
      const firstPinnedItemIndex = pinnedActionStartIndex;
      const selectedPinnedActionIndex = selectedIndex - pinnedActionStartIndex;
      const selectedWithinPinnedActions =
        selectedPinnedActionIndex >= 0 &&
        selectedPinnedActionIndex < pinnedActionItems.length;
      const nextIndex = forward
        ? selectedWithinPinnedActions
          ? firstMainItemIndex >= 0
            ? firstMainItemIndex
            : firstPinnedItemIndex
          : firstPinnedItemIndex
        : selectedWithinPinnedActions
          ? firstMainItemIndex >= 0
            ? firstMainItemIndex
            : firstPinnedItemIndex
          : firstPinnedItemIndex;

      setSelectedIndex(nextIndex);
    },
    [
      activeMode,
      isItemSelectable,
      mainItems,
      pinnedActionItems.length,
      pinnedActionStartIndex,
    ]
  );

  // ============ KERNEL ============
  const kernel = useSelectorKernel({
    isOpen,
    onClose,
    items,
    hasModalState,
    onGoBack: handleGoBack,
    isItemSelectable,
    onTab: handleSectionTab,
    onReset: () => {
      setSearchQueryState("");
      setActiveMode("checkout");
      setIsCreatingBranch(false);
      setSelectedStartPoint(null);
      setSelectedBranchNames(new Set());
    },
    externalSearchQuery: searchQuery,
    externalSetSearchQuery: setSearchQueryState,
  });
  const {
    setSelectedIndex,
    handleKeyDown: baseHandleKeyDown,
    focusInput,
    findFirstSelectable,
  } = kernel;

  // ============ EFFECTS ============
  useEffect(() => {
    focusInputRef.current = focusInput;
  }, [focusInput]);

  // Reset to first selectable item on mode change
  useEffect(() => {
    setSelectedIndex(findFirstSelectable());
    setSearchQueryState("");
  }, [activeMode, setSelectedIndex, findFirstSelectable]);

  // ============ HANDLERS ============

  const handleCreateBranch = useCallback(async () => {
    const branchName = activeMode === "add" ? searchQuery.trim() : "";
    if (!branchName || !onCreateBranch) return;

    setIsCreatingBranch(true);
    try {
      await onCreateBranch(branchName, selectedStartPoint ?? undefined);
      setSearchQueryState("");
      setSelectedStartPoint(null);
      setActiveMode("checkout");
      onClose();
    } catch (error) {
      log.error("[useBranchPalette] Failed to create branch:", error);
    } finally {
      setIsCreatingBranch(false);
    }
  }, [activeMode, searchQuery, onCreateBranch, onClose, selectedStartPoint]);

  // Wrap keyboard handling so Delete mirrors Backspace for dismissible pills,
  // while Enter still creates a branch from add mode.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (
        (event.key === "Backspace" || event.key === "Delete") &&
        searchQuery === "" &&
        hasModalState
      ) {
        event.preventDefault();
        handleGoBack();
        return;
      }

      // Enter in add mode creates branch
      if (activeMode === "add" && event.key === "Enter" && searchQuery.trim()) {
        event.preventDefault();
        handleCreateBranch();
        return;
      }

      baseHandleKeyDown(event);
    },
    [
      activeMode,
      searchQuery,
      hasModalState,
      handleGoBack,
      handleCreateBranch,
      baseHandleKeyDown,
    ]
  );

  // ============ PATH & PLACEHOLDER ============

  const getPath = useCallback(() => {
    const pathConfig = getModePath(BRANCH_PALETTE_CONFIG, activeMode);
    if (pathConfig) {
      const segment = buildPathSegment(pathConfig);
      const pathLabelMap: Record<BranchPaletteMode, string> = {
        checkout:
          variant === "create-session"
            ? t("selectors.branch.path.createSessionWith")
            : t("selectors.branch.path.checkoutBranch"),
        add: t("selectors.branch.path.createBranchCalled"),
        "add-from": t("selectors.branch.path.createBranchFrom"),
        remove: t("selectors.branch.path.delete"),
      };
      const pathTemplateMap: Record<BranchPaletteMode, string> = {
        checkout:
          variant === "create-session"
            ? t("selectors.branch.path.createSessionWithTemplate")
            : t("selectors.branch.path.checkoutTemplate"),
        add: t("selectors.branch.path.createBranchCalledTemplate"),
        "add-from": t("selectors.branch.path.createBranchFromTemplate"),
        remove: t("selectors.branch.path.deleteTemplate"),
      };

      return [
        {
          ...segment,
          label: pathLabelMap[activeMode],
          data: {
            ...segment.data,
            template: pathTemplateMap[activeMode],
          },
        },
      ];
    }

    return [];
  }, [activeMode, t, variant]);

  const getBranchPlaceholder = useCallback(() => {
    if (activeMode === "add") {
      return t("selectors.branch.placeholders.add");
    }
    return t("selectors.spotlight.placeholders.branch");
  }, [activeMode, t]);

  const getMissingParam = useCallback(() => {
    if (activeMode === "add") {
      return "name";
    }
    return "branch";
  }, [activeMode]);

  // Kernel with the Enter-creates-branch wrapper installed. PaletteBody
  // consumes this directly so the palette component doesn't have to
  // rebuild an ad-hoc kernel adapter.
  const paletteKernel = useMemo(
    () => ({ ...kernel, handleKeyDown }),
    [kernel, handleKeyDown]
  );

  return {
    // Kernel (for PaletteBody)
    kernel: paletteKernel,

    // Branch-specific state
    activeMode,
    setActiveMode,
    isCreatingBranch,
    selectedStartPoint,
    setSelectedStartPoint,

    // Data
    items: mainItems,
    pinnedActionItems,
    isLoading,

    // Actions
    refreshBranches,

    // Helpers
    getPath,
    getPlaceholder: getBranchPlaceholder,
    getMissingParam,
  };
}
