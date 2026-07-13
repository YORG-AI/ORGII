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
import { GitFork, Plus } from "lucide-react";
import React from "react";

import WorktreeSourceModal from "@src/features/SessionCreator/components/WorktreeSourceModal";
import { useFilteredItems } from "@src/hooks/search";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";

import {
  SPOTLIGHT_FOOTER_ACTIVE_CHIP,
  SpotlightPinnedActionSection,
} from "../../components";
import { PaletteBody, SpotlightShell } from "../../shell";
import type { SpotlightItem } from "../../types";
import { useSelectorKernel } from "../core";
import type { BranchPaletteProps, WorktreePaletteProps } from "./types";
import { useBranchPalette } from "./useBranchPalette";
import { useWorktreeEntries } from "./useWorktreeMap";

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
  asBody = false,
}) => {
  const [createModalOpen, setCreateModalOpen] = React.useState(false);
  const [searchQuery, setSearchQuery] = React.useState("");
  const worktrees = useWorktreeEntries({
    enabled: isOpen,
    repoId,
    repoPath,
    isLocalRepo: true,
  });
  const items = React.useMemo<SpotlightItem[]>(
    () =>
      worktrees.map((worktree) => {
        const path = normalizeWorktreePath(worktree.path);
        const label = worktree.is_main
          ? "Main Worktree"
          : path.split("/").pop() || path;
        const isSelected =
          path === normalizeWorktreePath(activePath || repoPath);
        return {
          id: `worktree:${path}`,
          label,
          desc: path,
          icon: GitFork,
          type: "option" as const,
          data: {
            isSelector: true,
            isCurrentSelection: isSelected,
            rightLabel: worktree.branch,
            tagLabel: isSelected ? "Current" : undefined,
          },
          action: () => {
            void Promise.resolve(onSelect(worktree)).then(onClose);
          },
        };
      }),
    [activePath, onClose, onSelect, repoPath, worktrees]
  );
  const createAction = React.useMemo<SpotlightItem>(
    () => ({
      id: "worktree:new",
      label: "New Worktree...",
      desc: "Create from a branch, PR, issue, or name",
      icon: Plus,
      type: "action",
      data: { showDisclosureChevron: true },
      action: () => setCreateModalOpen(true),
    }),
    []
  );
  const selectableItems = React.useMemo<SpotlightItem[]>(
    () => (onCreate ? [...items, createAction] : items),
    [createAction, items, onCreate]
  );
  const kernel = useSelectorKernel({
    isOpen,
    onClose,
    items: selectableItems,
    hasModalState: true,
    onGoBack: onGoBackToParent ?? onClose,
    isItemSelectable: () => true,
    externalSearchQuery: searchQuery,
    externalSetSearchQuery: setSearchQuery,
  });
  const { filteredItems } = useFilteredItems({
    items,
    searchQuery,
    getSearchText: (item) =>
      `${item.label} ${item.desc ?? ""} ${String(item.data?.rightLabel ?? "")}`,
  });

  const pinnedActionSection = onCreate ? (
    <SpotlightPinnedActionSection
      items={[createAction]}
      startIndex={items.length}
      selectedIndex={kernel.selectedIndex}
      onItemSelect={kernel.handleItemClick}
      onItemHover={kernel.setSelectedIndex}
      searchQuery={searchQuery}
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
      items={filteredItems}
      placeholder="worktree"
      path={[
        {
          type: "action",
          id: "switch-worktree",
          label: "Switch worktree",
          icon: GitFork,
          color: "",
          data: {
            template: "Switch to {worktree}",
            requiredParams: ["worktree"],
          },
        },
      ]}
      onRemoveSegment={() => (onGoBackToParent ?? onClose)()}
      isLoading={isOpen && worktrees.length === 0}
      containerHeight={350}
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
          onSelect={handleCreateSourceSelect}
        />
      )}
    </>
  );

  if (asBody) return palette;

  return (
    <SpotlightShell
      isOpen={isOpen}
      onClose={onClose}
      hasActiveAction
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
  onRemoveWorktree,
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
    onRemoveWorktree,
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
  WorktreePaletteProps,
} from "./types";
