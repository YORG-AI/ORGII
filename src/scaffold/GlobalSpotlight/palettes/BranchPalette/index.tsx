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
import { useAtom } from "jotai";
import React from "react";
import { useTranslation } from "react-i18next";

import WorktreeSourceModal from "@src/features/SessionCreator/components/WorktreeSourceModal";
import { useFilteredItems } from "@src/hooks/search";
import {
  FolderAddIcon,
  FolderClosedIcon,
  FolderMinusIcon,
  HugeiconsIcon,
  Refresh04Icon,
  Tick01Icon,
} from "@src/icons";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";
import { spotlightShowPathAtom } from "@src/store/ui/spotlightShowPathAtom";
import { compactRepoPathForDisplay } from "@src/util/file/repoPathDisplay";

import {
  SPOTLIGHT_FOOTER_ACTIVE_CHIP,
  SpotlightFooterToggle,
  SpotlightPinnedActionSection,
} from "../../components";
import { ICONS } from "../../config";
import { useRefreshSpin } from "../../shared";
import { PaletteBody, ShellFooterAction, SpotlightShell } from "../../shell";
import type { SpotlightItem } from "../../types";
import { useSelectorKernel } from "../core";
import type {
  BranchPaletteProps,
  WorktreePaletteMode,
  WorktreePaletteProps,
} from "./types";
import { useBranchPalette } from "./useBranchPalette";
import {
  refreshWorktreeMap,
  revalidateWorktreeMap,
  useWorktreeEntries,
} from "./useWorktreeMap";

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
  const [showPath, setShowPath] = useAtom(spotlightShowPathAtom);
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

  // Revalidate rather than refresh: the rows stay on screen while the
  // refetch runs, so only the icon reports the work. Spin timing is shared
  // with the branch palette's refresh.
  const revalidateWorktrees = React.useCallback(
    () => revalidateWorktreeMap(repoId, repoPath),
    [repoId, repoPath]
  );
  const { triggerRefresh, RefreshIcon } = useRefreshSpin(
    Refresh04Icon,
    revalidateWorktrees
  );

  // Same affordance as the workspace palette's manage mode: a danger-tinted
  // trash button on the row instead of a "Remove Worktree" text label.
  const renderWorktreeTrashAction = React.useCallback(
    (worktreePath: string, isRemoving: boolean): React.ReactNode => (
      <button
        type="button"
        disabled={isRemoving}
        onClick={(event) => {
          event.stopPropagation();
          void handleRemoveWorktree(worktreePath);
        }}
        className="flex items-center justify-center rounded-md p-1 text-danger-6 transition-colors hover:bg-danger-6/10 disabled:cursor-not-allowed disabled:opacity-50"
        title={t("selectors.branch.actions.removeWorktree", "Remove Worktree")}
        aria-label={t(
          "selectors.branch.actions.removeWorktree",
          "Remove Worktree"
        )}
      >
        <HugeiconsIcon icon={ICONS.removeRepo} size={14} />
      </button>
    ),
    [handleRemoveWorktree, t]
  );

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
          const displayPath = compactRepoPathForDisplay({ path });
          return {
            id: `worktree:${path}`,
            label,
            // The path only renders when the footer's "Show path" pill is
            // on; it stays searchable either way via `searchText`.
            desc: showPath ? displayPath : undefined,
            icon: FolderClosedIcon,
            type: "option" as const,
            data: {
              isSelector: true,
              isCurrentSelection: mode === "switch" && isSelected,
              disabled: isRemoving,
              contextMenuCopy: { name: label, path },
              searchText: `${label} ${displayPath}`,
              rightContent:
                mode === "remove"
                  ? renderWorktreeTrashAction(worktree.path, isRemoving)
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
      renderWorktreeTrashAction,
      showPath,
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
    getSearchText: (item) =>
      item.data?.searchText ?? `${item.label} ${item.desc ?? ""}`,
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
      icon: FolderAddIcon,
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
          icon: Tick01Icon,
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
        icon: FolderMinusIcon,
        type: "action",
        data: { showDisclosureChevron: true },
        action: () => setMode("remove"),
      });
    }
    actions.push({
      id: "worktree:refresh",
      label: t("actions.refresh", "Refresh"),
      icon: RefreshIcon,
      type: "action",
      action: triggerRefresh,
    });
    return actions;
  }, [
    RefreshIcon,
    createAction,
    mode,
    onCreate,
    onRemoveWorktree,
    t,
    triggerRefresh,
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
        // Switch mode fills two rows (new / remove / refresh); remove mode
        // shows only "Done". Reserving the taller layout keeps the panel
        // from resizing when the mode changes.
        reserveRows={onCreate && onRemoveWorktree ? 2 : 1}
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
          icon: mode === "remove" ? FolderMinusIcon : FolderClosedIcon,
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
      isLoading={isOpen && worktrees.length === 0}
      fixedHeight
      afterListSlot={pinnedActionSection}
    />
  );

  const showPathToggle = (
    <ShellFooterAction placement="inline">
      <SpotlightFooterToggle
        label={t("selectors.spotlightFooter.showPath", "Show path")}
        checked={showPath}
        onCheckedChange={setShowPath}
      />
    </ShellFooterAction>
  );

  const palette = (
    <>
      {body}
      {showPathToggle}
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
      // Tab switches between the list and the pinned actions in both modes,
      // so the hint chip stays put instead of swapping to "Back" the moment
      // remove mode opens.
      activeActionChip={SPOTLIGHT_FOOTER_ACTIVE_CHIP.switchSection}
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
      hideActionClose={hideActionClose && activeMode === "checkout"}
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
