/**
 * BranchPalette Component
 *
 * Unified branch palette component used by both:
 * - Global toolbar (variant="global"): checkout, create, create-from, remove modes
 * - Create session (variant="create-session"): checkout and create modes
 *
 * All variants fetch branches through the Rust git API
 * (`gitApi.getGitBranches`) and share the centralized branch cache to
 * prevent redundant calls.
 */
import {
  Check,
  Folder,
  FolderMinus,
  FolderPlus,
  RefreshCw,
} from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import WorktreeSourceModal from "@src/features/SessionCreator/components/WorktreeSourceModal";
import { useFilteredItems } from "@src/hooks/search";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";
import { compactRepoPathForDisplay } from "@src/util/file/repoPathDisplay";

import {
  SPOTLIGHT_FOOTER_ACTIVE_CHIP,
  SpotlightPinnedActionSection,
} from "../../components";
import { PaletteBody, SpotlightShell } from "../../shell";
import type { SpotlightItem } from "../../types";
import { useSelectorKernel } from "../core";
import type {
  BranchPaletteProps,
  WorktreePaletteMode,
  WorktreePaletteProps,
} from "./types";
import { useBranchPalette } from "./useBranchPalette";
import { refreshWorktreeMap, useWorktreeEntries } from "./useWorktreeMap";

function normalizeWorktreePath(path: string | undefined): string {
  return (path ?? "").replace(/^file:\/\//, "").replace(/\/+$/, "");
}

export const WorktreePalette: React.FC<WorktreePaletteProps> = ({
  isOpen,
  onClose,
  onGoBackToParent,
  repoId,
  repoPath,
  activePath,
  onSelect,
  onCreate,
  onRemoveWorktree,
  onModeChange,
  asBody = false,
}) => {
  const { t } = useTranslation();
  const [createModalOpen, setCreateModalOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const [mode, setMode] = React.useState<WorktreePaletteMode>("switch");
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [removingPaths, setRemovingPaths] = React.useState<Set<string>>(
    () => new Set()
  );
  const worktrees = useWorktreeEntries({
    enabled: isOpen,
    repoId,
    repoPath,
    isLocalRepo: true,
  });

  React.useEffect(() => {
    onModeChange?.(mode);
  }, [mode, onModeChange]);

  const normalizedActivePath = normalizeWorktreePath(activePath || repoPath);

  const handleRemoveWorktree = React.useCallback(
    async (worktreePath: string) => {
      if (!onRemoveWorktree) return;
      const normalizedPath = normalizeWorktreePath(worktreePath);
      setRemovingPaths((current) => new Set(current).add(normalizedPath));
      try {
        const result = await onRemoveWorktree(worktreePath, {
          skipRefresh: true,
        });
        if (result?.success === false) return;
        await refreshWorktreeMap(repoId, repoPath);
      } finally {
        setRemovingPaths((current) => {
          const next = new Set(current);
          next.delete(normalizedPath);
          return next;
        });
      }
    },
    [onRemoveWorktree, repoId, repoPath]
  );

  const handleRefreshWorktrees = React.useCallback(async () => {
    setIsRefreshing(true);
    try {
      await refreshWorktreeMap(repoId, repoPath);
    } finally {
      setIsRefreshing(false);
    }
  }, [repoId, repoPath]);

  const allItems = React.useMemo<SpotlightItem[]>(
    () =>
      worktrees
        .filter((worktree) => {
          if (mode === "switch") return true;
          const path = normalizeWorktreePath(worktree.path);
          return !worktree.is_main && path !== normalizedActivePath;
        })
        .map((worktree) => {
          const path = normalizeWorktreePath(worktree.path);
          const label =
            worktree.branch ||
            (worktree.is_main
              ? t("selectors.branch.labels.mainWorktree", "Main")
              : path.split("/").pop() || path);
          const isSelected = path === normalizedActivePath;
          const isRemoving = removingPaths.has(path);
          return {
            id: `worktree:${path}`,
            label,
            desc: compactRepoPathForDisplay({ path }),
            icon: Folder,
            type: "option" as const,
            data: {
              isSelector: true,
              isCurrentSelection: mode === "switch" && isSelected,
              disabled: isRemoving,
              contextMenuCopy: { name: label, path },
              rightLabel:
                mode === "remove"
                  ? t(
                      "selectors.branch.actions.removeWorktree",
                      "Remove Worktree"
                    )
                  : undefined,
            },
            action: () => {
              if (mode === "remove") {
                void handleRemoveWorktree(worktree.path);
                return;
              }
              void Promise.resolve(onSelect(worktree)).then(onClose);
            },
          };
        }),
    [
      handleRemoveWorktree,
      mode,
      normalizedActivePath,
      onClose,
      onSelect,
      removingPaths,
      t,
      worktrees,
    ]
  );
  // The main worktree is grouped separately from linked (secondary) ones.
  const mainWorktreeIds = React.useMemo(
    () =>
      new Set(
        worktrees
          .filter((worktree) => worktree.is_main)
          .map((worktree) => `worktree:${normalizeWorktreePath(worktree.path)}`)
      ),
    [worktrees]
  );
  const { filteredItems } = useFilteredItems({
    items: allItems,
    searchQuery,
    getSearchText: (item) => `${item.label} ${item.desc ?? ""}`,
  });
  const sectionedItems = React.useMemo<SpotlightItem[]>(() => {
    const header = (id: string, label: string): SpotlightItem => ({
      id,
      label,
      desc: "",
      icon: "",
      type: "option" as const,
      data: { isHeader: true },
      action: () => {},
    });
    const mainItems = filteredItems.filter((item) =>
      mainWorktreeIds.has(item.id)
    );
    const linkedItems = filteredItems.filter(
      (item) => !mainWorktreeIds.has(item.id)
    );
    const list: SpotlightItem[] = [];
    if (mode === "switch" && mainItems.length > 0) {
      list.push(
        header(
          "worktree:header-main",
          t("selectors.branch.labels.mainWorktreeSection", "Main worktree")
        ),
        ...mainItems
      );
    }
    if (linkedItems.length > 0) {
      list.push(
        header(
          "worktree:header-linked",
          t("selectors.branch.labels.linkedWorktrees", "Linked worktrees")
        ),
        ...linkedItems
      );
    }
    return list;
  }, [filteredItems, mainWorktreeIds, mode, t]);
  const createAction = React.useMemo<SpotlightItem>(
    () => ({
      id: "worktree:new",
      label: t("selectors.branch.actions.newWorktree", "New Worktree..."),
      icon: FolderPlus,
      type: "action",
      data: { showDisclosureChevron: true },
      action: () => setCreateModalOpen(true),
    }),
    [t]
  );
  const pinnedActionItems = React.useMemo<SpotlightItem[]>(() => {
    if (mode === "remove") {
      return [
        {
          id: "worktree:remove-done",
          label: t("actions.done", "Done"),
          icon: Check,
          type: "action",
          action: () => setMode("switch"),
        },
      ];
    }

    const actions: SpotlightItem[] = [];
    if (onCreate) actions.push(createAction);
    if (onRemoveWorktree) {
      actions.push({
        id: "worktree:remove",
        label: t("selectors.branch.actions.removeWorktree", "Remove Worktree"),
        icon: FolderMinus,
        type: "action",
        data: { showDisclosureChevron: true },
        action: () => setMode("remove"),
      });
    }
    const RefreshIcon = (props: { size?: number; className?: string }) =>
      React.createElement(RefreshCw, {
        ...props,
        className:
          `${props.className ?? ""} ${isRefreshing ? "spotlight-refresh-spin" : ""}`.trim(),
      });

    actions.push({
      id: "worktree:refresh",
      label: t("actions.refresh", "Refresh"),
      icon: RefreshIcon,
      type: "action",
      data: { disabled: isRefreshing },
      action: () => void handleRefreshWorktrees(),
    });
    return actions;
  }, [
    createAction,
    handleRefreshWorktrees,
    isRefreshing,
    mode,
    onCreate,
    onRemoveWorktree,
    t,
  ]);
  const selectableItems = React.useMemo<SpotlightItem[]>(
    () => [...sectionedItems, ...pinnedActionItems],
    [pinnedActionItems, sectionedItems]
  );
  const handleGoBack = React.useCallback(() => {
    if (mode === "remove") {
      setMode("switch");
      setSearchQuery("");
      return;
    }
    (onGoBackToParent ?? onClose)();
  }, [mode, onClose, onGoBackToParent]);
  const kernel = useSelectorKernel({
    isOpen,
    onClose,
    items: selectableItems,
    hasModalState: true,
    onGoBack: handleGoBack,
    isItemSelectable: (item) => !item.data?.isHeader && !item.data?.disabled,
    onReset: () => {
      setMode("switch");
      setRemovingPaths(new Set());
    },
    externalSearchQuery: searchQuery,
    externalSetSearchQuery: setSearchQuery,
  });

  const pinnedActionSection =
    pinnedActionItems.length > 0 ? (
      <SpotlightPinnedActionSection
        items={pinnedActionItems}
        startIndex={sectionedItems.length}
        selectedIndex={kernel.selectedIndex}
        onItemSelect={kernel.handleItemClick}
        onItemHover={kernel.setSelectedIndex}
        searchQuery={searchQuery}
        layout="twoColumn"
      />
    ) : undefined;

  const handleCreateSourceSelect = React.useCallback(
    (source: WorktreeLaunchSource) => {
      setCreateModalOpen(false);
      void Promise.resolve(onCreate?.(source));
    },
    [onCreate]
  );

  const body = (
    <PaletteBody
      kernel={kernel}
      items={sectionedItems}
      placeholder={t(
        "selectors.spotlight.placeholders.worktree",
        "Search worktree..."
      )}
      path={[
        {
          type: "action",
          id: mode === "remove" ? "remove-worktree" : "switch-worktree",
          label:
            mode === "remove"
              ? t("selectors.branch.actions.removeWorktree", "Remove Worktree")
              : t("selectors.branch.path.switchWorktree", "Switch worktree"),
          icon: mode === "remove" ? FolderMinus : Folder,
          color: "",
          data:
            mode === "switch"
              ? {
                  template: t(
                    "selectors.branch.path.switchWorktreeTemplate",
                    "Switch to {worktree}"
                  ),
                  requiredParams: ["worktree"],
                }
              : undefined,
        },
      ]}
      onRemoveSegment={handleGoBack}
      isLoading={isOpen && (worktrees.length === 0 || isRefreshing)}
      fixedHeight
      afterListSlot={pinnedActionSection}
    />
  );

  const palette = (
    <>
      {body}
      {createModalOpen && (
        <WorktreeSourceModal
          open
          repoId={repoId}
          repoPath={repoPath}
          branchName={
            worktrees.find(
              (worktree) =>
                normalizeWorktreePath(worktree.path) ===
                normalizeWorktreePath(activePath || repoPath)
            )?.branch
          }
          onClose={() => setCreateModalOpen(false)}
          onSelect={({ source }) => handleCreateSourceSelect(source)}
        />
      )}
    </>
  );

  if (asBody) return palette;

  return (
    <SpotlightShell
      isOpen={isOpen}
      onClose={onClose}
      hasActiveAction={pinnedActionItems.length > 0}
      activeActionChip={
        mode === "switch"
          ? SPOTLIGHT_FOOTER_ACTIVE_CHIP.switchSection
          : undefined
      }
    >
      {palette}
    </SpotlightShell>
  );
};

// ============ COMPONENT ============

export const BranchPalette: React.FC<BranchPaletteProps> = ({
  isOpen,
  onClose,
  onSelect,
  repoId,
  repoPath: repoPathProp,
  currentBranchName,
  groupWorktreeBranches = true,
  onCreateBranch,
  onDeleteBranch,
  onCheckoutDetached,
  githubConnectionId,
  githubRepoFullName,
  variant = "global",
  showRemoveMode,
  asBody = false,
  hideActionClose = false,
  onModeChange,
  onGoBackToParent,
}) => {
  const effectiveShowRemoveMode = showRemoveMode ?? variant === "global";

  const {
    kernel,
    activeMode,
    setActiveMode,
    isCreatingBranch,
    setSelectedStartPoint,
    items,
    pinnedActionItems,
    isLoading,
    getPath,
    getPlaceholder,
  } = useBranchPalette({
    isOpen,
    repoId,
    repoPathProp,
    currentBranchName,
    groupWorktreeBranches,
    onSelect,
    onCreateBranch,
    onDeleteBranch,
    onCheckoutDetached,
    onClose,
    onGoBackToParent,
    variant,
    effectiveShowRemoveMode,
    parentModalState: asBody || !!onGoBackToParent,
    githubConnectionId,
    githubRepoFullName,
  });

  React.useEffect(() => {
    onModeChange?.(activeMode);
  }, [activeMode, onModeChange]);

  const handleRemovePathSegment = React.useCallback(() => {
    if (activeMode === "checkout") {
      if (onGoBackToParent) {
        onGoBackToParent();
        return;
      }
      onClose();
      return;
    }
    setSelectedStartPoint(null);
    setActiveMode("checkout");
    kernel.setSearchQuery("");
  }, [
    activeMode,
    kernel,
    onClose,
    onGoBackToParent,
    setActiveMode,
    setSelectedStartPoint,
  ]);

  const pinnedActionStartIndex = items.length;
  const pinnedActionSection =
    activeMode === "checkout" || activeMode === "remove" ? (
      <SpotlightPinnedActionSection
        items={pinnedActionItems}
        startIndex={pinnedActionStartIndex}
        selectedIndex={kernel.selectedIndex}
        onItemSelect={kernel.handleItemClick}
        onItemHover={kernel.setSelectedIndex}
        searchQuery={kernel.searchQuery}
        layout="twoColumn"
      />
    ) : undefined;

  const body = (
    <PaletteBody
      kernel={kernel}
      items={items}
      placeholder={getPlaceholder()}
      path={getPath()}
      onRemoveSegment={handleRemovePathSegment}
      isLoading={isLoading || isCreatingBranch}
      hideActionClose={hideActionClose}
      containerHeight={350}
      fixedHeight
      contentOverride={activeMode === "add" ? <></> : undefined}
      afterListSlot={pinnedActionSection}
    />
  );

  if (asBody) return body;

  return (
    <SpotlightShell
      isOpen={isOpen}
      onClose={onClose}
      hasActiveAction={
        (activeMode === "checkout" || activeMode === "remove") &&
        pinnedActionItems.length > 0
      }
      activeActionChip={SPOTLIGHT_FOOTER_ACTIVE_CHIP.switchSection}
    >
      {body}
    </SpotlightShell>
  );
};

export type {
  BranchPaletteProps,
  BranchPaletteMode,
  WorktreePaletteMode,
  WorktreePaletteProps,
} from "./types";
