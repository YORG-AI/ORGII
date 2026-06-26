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
import React from "react";

import {
  SPOTLIGHT_FOOTER_ACTIVE_CHIP,
  SpotlightPinnedActionSection,
} from "../../components";
import { PaletteBody, SpotlightShell } from "../../shell";
import type { BranchPaletteProps } from "./types";
import { useBranchPalette } from "./useBranchPalette";

// ============ COMPONENT ============

export const BranchPalette: React.FC<BranchPaletteProps> = ({
  isOpen,
  onClose,
  onSelect,
  repoId,
  repoPath: repoPathProp,
  currentBranchName,
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

export type { BranchPaletteProps, BranchPaletteMode } from "./types";
