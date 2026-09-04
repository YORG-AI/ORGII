import React from "react";
import { useTranslation } from "react-i18next";

import {
  SPOTLIGHT_FOOTER_ACTIVE_CHIP,
  SpotlightPinnedActionSection,
} from "../../components";
import { PaletteBody, SpotlightShell } from "../../shell";
import { type BranchPickerTab, BranchPickerTabs } from "./BranchPickerTabs";
import { BranchPullRequestPicker } from "./BranchPullRequestPicker";
import type { BranchPaletteProps } from "./types";
import { useBranchPalette } from "./useBranchPalette";

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
  const { t } = useTranslation();
  const [tab, setTab] = React.useState<BranchPickerTab>("branches");
  React.useEffect(() => {
    if (!isOpen) setTab("branches");
  }, [isOpen, repoId]);
  const effectiveShowRemoveMode = showRemoveMode ?? variant === "global";

  const {
    kernel,
    repoPath,
    activeMode,
    setActiveMode,
    isCreatingBranch,
    setSelectedStartPoint,
    items,
    pinnedActionItems,
    isLoading,
    refreshBranches,
    getPath,
    getPlaceholder,
  } = useBranchPalette({
    isOpen: isOpen && tab === "branches",
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

  const body =
    tab === "prs" && isOpen ? (
      <BranchPullRequestPicker
        key={`${repoId}:${repoPath}`}
        repoId={repoId}
        repoPath={repoPath}
        onSelect={onSelect}
        onClose={onClose}
        onBranchPrepared={refreshBranches}
        onTabChange={setTab}
      />
    ) : (
      <PaletteBody
        kernel={kernel}
        items={items}
        placeholder={getPlaceholder()}
        path={activeMode === "checkout" ? [] : getPath()}
        inputAriaLabel={t(
          variant === "create-session"
            ? "selectors.branch.path.createSessionWith"
            : "selectors.branch.path.checkoutBranch"
        )}
        inputLeadingSlot={
          activeMode === "checkout" ? (
            <BranchPickerTabs value={tab} onChange={setTab} />
          ) : undefined
        }
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
        tab === "prs" ||
        ((activeMode === "checkout" || activeMode === "remove") &&
          pinnedActionItems.length > 0)
      }
      activeActionChip={SPOTLIGHT_FOOTER_ACTIVE_CHIP.switchSection}
    >
      {body}
    </SpotlightShell>
  );
};
