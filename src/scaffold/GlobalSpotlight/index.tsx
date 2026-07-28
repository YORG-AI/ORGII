/**
 * GlobalSpotlight Component (NEW ARCHITECTURE)
 *
 * Command palette with reducer-based state management.
 * Modularized for better maintainability.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { currentBranchAtom } from "@src/store/repo";
import {
  activeWorktreeAtom,
  setActiveWorktreeAtom,
} from "@src/store/workspace";

import { SPOTLIGHT_FOOTER_ACTIVE_CHIP } from "./components";
import { getEditorPaletteMode } from "./globalSpotlight.helpers";
import {
  type AddWorkspaceModalStage,
  SpotlightProvider,
  useSpotlight,
  useSpotlightEffects,
} from "./hooks";
import { useSpotlightOverlayLayers } from "./hooks/features/useSpotlightOverlayLayers";
import { useSpotlightPickerActions } from "./hooks/features/useSpotlightPickerActions";
import {
  AgentControlPalette,
  AgentSessionSearchPalette,
  AllSessionsSearchPalette,
  BranchPalette,
  EditorPalette,
  SessionCreatorPalette,
  WorkspacePalette,
  WorktreePalette,
} from "./palettes";
import { useSelectorKernel } from "./palettes/core";
import { PaletteBody, SpotlightShell } from "./shell";
import type { GlobalSpotlightProps } from "./types";
import { SpotlightConfirmationView } from "./views";

// ============================================
// INNER COMPONENT
// ============================================

const GlobalSpotlightInner: React.FC<
  GlobalSpotlightProps & { isOpen: boolean; closeModal: () => void }
> = (props) => {
  const { isOpen, closeModal } = props;

  const { t } = useTranslation();
  const location = useLocation();
  const {
    selectedRepoId,
    currentRepo,
    currentBranch: selectedBranchName,
    selectRepo,
    selectBranch,
    refreshBranches,
  } = useRepoSelection({ autoLoad: false });
  const activeWorktree = useAtomValue(activeWorktreeAtom);
  const setActiveWorktree = useSetAtom(setActiveWorktreeAtom);
  const setCurrentBranch = useSetAtom(currentBranchAtom);

  const isWorkStationRoute = location.pathname.startsWith(
    ROUTES.workStation.base.path
  );
  const isEditorRoute = location.pathname.startsWith(
    ROUTES.workStation.code.path
  );
  const currentRepoPath = currentRepo?.path ?? currentRepo?.fs_uri ?? "";

  const {
    workspacePickerMode,
    setWorkspacePickerMode,
    embeddedBranchMode,
    setEmbeddedBranchMode,
    embeddedWorktreeMode,
    setEmbeddedWorktreeMode,
    branchPickerOpen,
    setBranchPickerOpen,
    worktreePickerOpen,
    setWorktreePickerOpen,
    agentSessionSearchOpen,
    allSessionsSearchOpen,
    agentControlOpen,
    sessionCreatorOpen,
    embeddedEditorPalette,
    lastActivatedItemIdRef,
    pendingRestoreItemId,
    setPendingRestoreItemId,
    restoreLastActivatedItem,
    handleOpenWorkspacePicker,
    handleOpenBranchPicker,
    handleOpenWorktreePicker,
    handleOpenAgentSessionSearch,
    handleOpenAllSessionsSearch,
    handleOpenAgentControl,
    handleOpenSessionCreator,
    handleOpenEditorPalette,
    handleCloseWorkspacePicker,
    handleCloseBranchPicker,
    handleCloseWorktreePicker,
    handleCloseAgentSessionSearch,
    handleCloseAllSessionsSearch,
    handleCloseAgentControl,
    handleCloseSessionCreator,
    handleCloseEditorPalette,
  } = useSpotlightOverlayLayers(isOpen);

  const {
    handleWorkspaceSelect,
    handleWorktreePickerSelect,
    handleWorktreePickerCreate,
    handleBranchPickerSelect,
    handleCreateBranch,
    handleDeleteBranch,
    handleRemoveWorktree,
    handleCheckoutDetached,
  } = useSpotlightPickerActions({
    selectedRepoId,
    currentRepo,
    currentRepoPath,
    selectRepo,
    selectBranch,
    refreshBranches,
    closeModal,
    t,
    setActiveWorktree,
    setCurrentBranch,
    setWorkspacePickerMode,
    setBranchPickerOpen,
    setWorktreePickerOpen,
  });

  // ============ ALL HOOKS MUST BE CALLED UNCONDITIONALLY ============
  // These hooks are needed for normal mode, but must always be called
  // to satisfy React's rules of hooks (same order every render)
  const spotlight = useSpotlight({
    ...props,
    closeModal,
    onOpenWorkspacePicker: handleOpenWorkspacePicker,
    onOpenBranchPicker: handleOpenBranchPicker,
    onOpenEditorPalette: handleOpenEditorPalette,
    onOpenAgentSessionSearch: handleOpenAgentSessionSearch,
    onOpenAllSessionsSearch: handleOpenAllSessionsSearch,
    isEditorRoute,
    isWorkStationRoute,
    currentRepoId: selectedRepoId || currentRepo?.id,
  });
  const { dispatch: spotlightDispatch, state: spotlightState } = spotlight;
  const activeEditorPalette = embeddedEditorPalette;

  useSpotlightEffects({
    isOpen:
      isOpen &&
      !workspacePickerMode &&
      !branchPickerOpen &&
      !worktreePickerOpen &&
      !agentSessionSearchOpen &&
      !allSessionsSearchOpen &&
      !agentControlOpen &&
      !sessionCreatorOpen,
    dispatch: spotlightDispatch,
    closeModal,
    onOpenWorkspaceLayer: handleOpenWorkspacePicker,
    onOpenBranchLayer: handleOpenBranchPicker,
    onOpenWorktreeLayer: handleOpenWorktreePicker,
    onOpenEditorLayer: handleOpenEditorPalette,
    onOpenAgentSessionSearchLayer: handleOpenAgentSessionSearch,
    onOpenAllSessionsSearchLayer: handleOpenAllSessionsSearch,
    onOpenAgentControlLayer: handleOpenAgentControl,
    onOpenSessionCreatorLayer: handleOpenSessionCreator,
  });

  // Default view kernel — same hook every palette uses. Owns the input
  // ref, auto-focus, selectedIndex, and keyboard navigation. The reducer
  // remains the source of truth for searchQuery and path; the default view
  // bridges them through the kernel's external* options.
  const pathLength = spotlightState.path.length;
  const handleGoBack = useCallback(() => {
    if (pathLength === 1) {
      restoreLastActivatedItem();
    }
    spotlightDispatch({ type: "POP_SEGMENT" });
  }, [pathLength, restoreLastActivatedItem, spotlightDispatch]);
  const handleSetSearchQuery = useCallback(
    (query: string) => {
      const mode = getEditorPaletteMode(query);
      if (pathLength === 0 && isEditorRoute && mode === "symbol") {
        spotlightDispatch({ type: "SET_SEARCH_QUERY", payload: { query: "" } });
        handleOpenEditorPalette(query, mode);
        return;
      }

      spotlightDispatch({ type: "SET_SEARCH_QUERY", payload: { query } });
    },
    [handleOpenEditorPalette, isEditorRoute, pathLength, spotlightDispatch]
  );
  const handleExternalKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLInputElement>,
      internal: (e: React.KeyboardEvent<HTMLInputElement>) => void
    ) => {
      // Escape with an active path clears the path instead of closing.
      if (event.key === "Escape" && pathLength > 0) {
        event.preventDefault();
        restoreLastActivatedItem();
        spotlightDispatch({ type: "CLEAR_PATH" });
        return;
      }
      internal(event);
    },
    [restoreLastActivatedItem, spotlightDispatch, pathLength]
  );
  const defaultKernel = useSelectorKernel({
    isOpen:
      isOpen &&
      !branchPickerOpen &&
      !worktreePickerOpen &&
      !agentSessionSearchOpen &&
      !allSessionsSearchOpen &&
      !agentControlOpen &&
      !sessionCreatorOpen &&
      !activeEditorPalette,
    onClose: closeModal,
    items: spotlight.items,
    hasModalState: pathLength > 0,
    onGoBack: handleGoBack,
    externalSearchQuery: spotlightState.searchQuery,
    externalSetSearchQuery: handleSetSearchQuery,
    isItemSelectable: (item) => !item.data?.isHeader && !item.data?.disabled,
    onActivateItem: (item) => {
      if (pathLength === 0) {
        lastActivatedItemIdRef.current = item.id;
      }
    },
    externalHandleKeyDown: handleExternalKeyDown,
  });
  const setDefaultSelectedIndex = defaultKernel.setSelectedIndex;

  useEffect(() => {
    if (
      workspacePickerMode ||
      branchPickerOpen ||
      worktreePickerOpen ||
      agentSessionSearchOpen ||
      allSessionsSearchOpen ||
      agentControlOpen ||
      sessionCreatorOpen ||
      !pendingRestoreItemId
    ) {
      return;
    }

    const entryIndex = spotlight.items.findIndex(
      (item) => item.id === pendingRestoreItemId
    );
    if (entryIndex < 0) return;

    let cancelled = false;
    Promise.resolve().then(() => {
      if (cancelled) return;
      setDefaultSelectedIndex(entryIndex);
      setPendingRestoreItemId(null);
    });

    return () => {
      cancelled = true;
    };
  }, [
    pendingRestoreItemId,
    setDefaultSelectedIndex,
    setPendingRestoreItemId,
    spotlight.items,
    workspacePickerMode,
    branchPickerOpen,
    worktreePickerOpen,
    agentSessionSearchOpen,
    allSessionsSearchOpen,
    agentControlOpen,
    sessionCreatorOpen,
  ]);

  // ============ NORMAL MODE ============

  // ============ RENDER HELPERS ============
  const getPlaceholder = (): string => {
    if (spotlight.state.stage === "confirming") return "";
    if (spotlight.state.path.length === 0) {
      return t("selectors.spotlight.placeholder");
    }

    switch (spotlight.state.missingParam) {
      case "repo":
        return t("selectors.spotlight.placeholders.workspace");
      case "branch":
        return t("selectors.spotlight.placeholders.branch");
      case "source":
        return t("selectors.spotlight.placeholders.source");
      case "language":
        return t("settings:general.languageSearchPlaceholder");
      default:
        return t("selectors.spotlight.placeholders.actions");
    }
  };

  // ============ EARLY RETURN ============
  if (!isOpen) return null;

  // ============ CONFIRMATION PAGE ============
  // Confirmation takes over the entire shell (no footer, no palette body).
  const showConfirmation =
    spotlight.confirmationPage.showConfirmation &&
    spotlight.confirmationPage.confirmationData;

  // Single SpotlightShell wraps the whole normal-mode tree.
  const hasActiveAction =
    !!workspacePickerMode ||
    branchPickerOpen ||
    worktreePickerOpen ||
    agentSessionSearchOpen ||
    allSessionsSearchOpen ||
    agentControlOpen ||
    sessionCreatorOpen ||
    !!activeEditorPalette ||
    spotlight.state.path.length > 0;
  const effectiveCurrentRepoId = selectedRepoId || undefined;
  const initialWorkspaceStage: AddWorkspaceModalStage =
    workspacePickerMode === "create"
      ? "create-workspace"
      : workspacePickerMode === "open"
        ? "add-workspace-existing"
        : null;
  const activeActionChip =
    workspacePickerMode === "switch" ||
    (worktreePickerOpen && embeddedWorktreeMode === "switch") ||
    (branchPickerOpen && embeddedBranchMode === "checkout")
      ? SPOTLIGHT_FOOTER_ACTIVE_CHIP.switchSection
      : undefined;

  const body = workspacePickerMode ? (
    <WorkspacePalette
      key={workspacePickerMode}
      isOpen={isOpen}
      onClose={closeModal}
      onGoBackToParent={handleCloseWorkspacePicker}
      onSelect={handleWorkspaceSelect}
      currentRepoId={effectiveCurrentRepoId}
      initialAddMenu={workspacePickerMode === "add"}
      initialAddStage={initialWorkspaceStage}
      asBody
    />
  ) : branchPickerOpen ? (
    <BranchPalette
      isOpen={isOpen}
      onClose={closeModal}
      onGoBackToParent={handleCloseBranchPicker}
      onSelect={handleBranchPickerSelect}
      onCreateBranch={handleCreateBranch}
      onDeleteBranch={handleDeleteBranch}
      onCheckoutDetached={handleCheckoutDetached}
      repoId={effectiveCurrentRepoId ?? ""}
      repoPath={activeWorktree?.path ?? currentRepoPath}
      currentBranchName={selectedBranchName}
      asBody
      onModeChange={setEmbeddedBranchMode}
    />
  ) : worktreePickerOpen ? (
    <WorktreePalette
      isOpen={isOpen}
      onClose={closeModal}
      onGoBackToParent={handleCloseWorktreePicker}
      onSelect={handleWorktreePickerSelect}
      onCreate={handleWorktreePickerCreate}
      onRemoveWorktree={handleRemoveWorktree}
      onModeChange={setEmbeddedWorktreeMode}
      repoId={effectiveCurrentRepoId ?? ""}
      repoPath={currentRepoPath}
      activePath={activeWorktree?.path ?? currentRepoPath}
      asBody
    />
  ) : agentSessionSearchOpen ? (
    <AgentSessionSearchPalette
      isOpen={isOpen}
      onClose={closeModal}
      onGoBackToParent={handleCloseAgentSessionSearch}
      asBody
    />
  ) : allSessionsSearchOpen ? (
    <AllSessionsSearchPalette
      isOpen={isOpen}
      onClose={closeModal}
      onGoBackToParent={handleCloseAllSessionsSearch}
      asBody
    />
  ) : agentControlOpen ? (
    <AgentControlPalette
      isOpen={isOpen}
      onClose={closeModal}
      onGoBackToParent={handleCloseAgentControl}
      asBody
    />
  ) : sessionCreatorOpen ? (
    <SessionCreatorPalette
      isOpen={isOpen}
      onClose={closeModal}
      onGoBackToParent={handleCloseSessionCreator}
      asBody
    />
  ) : activeEditorPalette ? (
    <EditorPalette
      key={activeEditorPalette.query}
      isOpen={isOpen}
      onClose={closeModal}
      repoPath={currentRepoPath}
      initialMode={activeEditorPalette.mode}
      initialQuery={activeEditorPalette.query}
      onGoBackToParent={handleCloseEditorPalette}
      hideFileModeHints={activeEditorPalette.mode === "file"}
      asBody
    />
  ) : showConfirmation ? (
    <SpotlightConfirmationView confirmationPage={spotlight.confirmationPage} />
  ) : (
    <PaletteBody
      kernel={defaultKernel}
      items={spotlight.items}
      placeholder={getPlaceholder()}
      path={spotlight.state.path}
      onRemoveSegment={(index) => {
        if (index === 0) {
          restoreLastActivatedItem();
        }
        spotlight.dispatch({ type: "TRUNCATE_PATH", payload: { index } });
      }}
      containerHeight={400}
    />
  );

  return (
    <SpotlightShell
      isOpen={isOpen}
      onClose={closeModal}
      hasActiveAction={hasActiveAction}
      activeActionChip={activeActionChip}
      hideFooter={!!showConfirmation || agentControlOpen || sessionCreatorOpen}
    >
      {body}
    </SpotlightShell>
  );
};

// ============================================
// MAIN COMPONENT WITH PROVIDER
// ============================================

export const GlobalSpotlight: React.FC<GlobalSpotlightProps> = (props) => {
  const { isOpen: externalIsOpen, onClose: onCloseFromParent } = props;

  const [isModalOpen, setIsModalOpen] = useState(false);

  // Determine actual open state — parent controls visibility when provided.
  const isOpen = externalIsOpen !== undefined ? externalIsOpen : isModalOpen;

  const closeModal = useCallback(() => {
    if (onCloseFromParent) {
      onCloseFromParent();
      return;
    }
    setIsModalOpen(false);
  }, [onCloseFromParent]);

  return (
    <SpotlightProvider>
      <GlobalSpotlightInner
        {...props}
        isOpen={isOpen}
        closeModal={closeModal}
      />
    </SpotlightProvider>
  );
};

export default GlobalSpotlight;

// ============================================
// EXPORTS
// ============================================

export { WorkspacePalette, BranchPalette } from "./palettes";
