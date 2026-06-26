/**
 * GlobalSpotlight Component (NEW ARCHITECTURE)
 *
 * Command palette with reducer-based state management.
 * Modularized for better maintainability.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

import { gitApi, removeGitWorktree } from "@src/api/http/git";
import { ROUTES } from "@src/config/routes";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { showGitActionDialogSafely } from "@src/util/dialogs/gitActionDialog";

import { SPOTLIGHT_FOOTER_ACTIVE_CHIP } from "./components";
import {
  type AddWorkspaceModalStage,
  SpotlightProvider,
  useSpotlight,
  useSpotlightEffects,
} from "./hooks";
import {
  AgentControlPalette,
  AgentSessionSearchPalette,
  BranchPalette,
  EditorPalette,
  SessionCreatorPalette,
  WorkspacePalette,
} from "./palettes";
import type { BranchPaletteMode } from "./palettes/BranchPalette";
import type {
  DeleteBranchOptions,
  DeleteBranchResult,
  RemoveWorktreeOptions,
  RemoveWorktreeResult,
} from "./palettes/BranchPalette/types";
import type { EditorPaletteMode } from "./palettes/EditorPalette/types";
import { useSelectorKernel } from "./palettes/core";
import { PaletteBody, SpotlightShell } from "./shell";
import type { GlobalSpotlightProps, RepoItem } from "./types";
import { SpotlightConfirmationView } from "./views";

type WorkspacePickerMode = "switch" | "open" | "add" | "create";

interface EmbeddedEditorPaletteState {
  mode: EditorPaletteMode;
  query: string;
}

function getEditorPaletteMode(query: string): EditorPaletteMode {
  if (query.startsWith(">")) return "command";
  if (query.startsWith("@")) return "symbol";
  return "file";
}

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
  const [workspacePickerMode, setWorkspacePickerMode] =
    useState<WorkspacePickerMode | null>(null);
  const [embeddedBranchMode, setEmbeddedBranchMode] =
    useState<BranchPaletteMode>("checkout");
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [agentSessionSearchOpen, setAgentSessionSearchOpen] = useState(false);
  const [agentControlOpen, setAgentControlOpen] = useState(false);
  const [sessionCreatorOpen, setSessionCreatorOpen] = useState(false);
  const [embeddedEditorPalette, setEmbeddedEditorPalette] =
    useState<EmbeddedEditorPaletteState | null>(null);
  const lastActivatedItemIdRef = useRef<string | null>(null);
  const [pendingRestoreItemId, setPendingRestoreItemId] = useState<
    string | null
  >(null);

  const isWorkStationRoute = location.pathname.startsWith(
    ROUTES.workStation.base.path
  );
  const isEditorRoute = location.pathname.startsWith(
    ROUTES.workStation.code.path
  );
  const currentRepoPath = currentRepo?.path ?? currentRepo?.fs_uri ?? "";

  const handleOpenWorkspacePicker = useCallback((mode: WorkspacePickerMode) => {
    setWorkspacePickerMode(mode);
  }, []);

  const handleOpenBranchPicker = useCallback(() => {
    setBranchPickerOpen(true);
  }, []);

  const handleOpenAgentSessionSearch = useCallback(() => {
    setAgentSessionSearchOpen(true);
  }, []);

  const handleOpenAgentControl = useCallback(() => {
    setAgentControlOpen(true);
  }, []);

  const handleOpenSessionCreator = useCallback(() => {
    setSessionCreatorOpen(true);
  }, []);

  const handleOpenEditorPalette = useCallback(
    (query: string, mode?: EditorPaletteMode) => {
      setEmbeddedEditorPalette({
        mode: mode ?? getEditorPaletteMode(query),
        query,
      });
    },
    []
  );

  const restoreLastActivatedItem = useCallback(() => {
    setPendingRestoreItemId(lastActivatedItemIdRef.current);
  }, []);

  const handleCloseWorkspacePicker = useCallback(() => {
    setWorkspacePickerMode(null);
    restoreLastActivatedItem();
  }, [restoreLastActivatedItem]);

  const handleCloseBranchPicker = useCallback(() => {
    setBranchPickerOpen(false);
    restoreLastActivatedItem();
  }, [restoreLastActivatedItem]);

  const handleCloseAgentSessionSearch = useCallback(() => {
    setAgentSessionSearchOpen(false);
    restoreLastActivatedItem();
  }, [restoreLastActivatedItem]);

  const handleCloseAgentControl = useCallback(() => {
    setAgentControlOpen(false);
    restoreLastActivatedItem();
  }, [restoreLastActivatedItem]);

  const handleCloseSessionCreator = useCallback(() => {
    setSessionCreatorOpen(false);
    restoreLastActivatedItem();
  }, [restoreLastActivatedItem]);

  const handleCloseEditorPalette = useCallback(() => {
    setEmbeddedEditorPalette(null);
    restoreLastActivatedItem();
  }, [restoreLastActivatedItem]);

  const handleWorkspaceSelect = useCallback(
    (repoId: string, _repo: RepoItem) => {
      selectRepo(repoId);
      setWorkspacePickerMode(null);
      closeModal();
    },
    [closeModal, selectRepo]
  );

  const handleBranchPickerSelect = useCallback(
    async (branchName: string) => {
      // Await the guarded checkout BEFORE tearing down the modal — otherwise
      // closeModal() races the CheckoutConflictDialog selectBranch may open.
      await selectBranch(branchName);
      setBranchPickerOpen(false);
      closeModal();
    },
    [closeModal, selectBranch]
  );

  const handleCreateBranch = useCallback(
    async (branchName: string, startPoint?: string) => {
      if (!selectedRepoId || !currentRepo) {
        showGitActionDialogSafely("No repo selected", "error");
        return;
      }

      // Create WITHOUT checking out, then route the checkout through
      // selectBranch so a dirty working tree surfaces the CheckoutConflictDialog
      // instead of the raw create+checkout bypassing the guard.
      const success = await gitApi.gitCreateBranch({
        repo_id: selectedRepoId,
        repo_path: currentRepo.path,
        name: branchName,
        start_point: startPoint ?? null,
        checkout: false,
      });

      if (!success) {
        showGitActionDialogSafely(
          `Failed to create branch "${branchName}"`,
          "error"
        );
        return;
      }

      showGitActionDialogSafely(`Branch "${branchName}" created`, "info");
      await selectBranch(branchName);
      setBranchPickerOpen(false);
      closeModal();
    },
    [closeModal, currentRepo, selectBranch, selectedRepoId]
  );

  const handleDeleteBranch = useCallback(
    async (
      branchName: string,
      options?: DeleteBranchOptions
    ): Promise<DeleteBranchResult> => {
      if (!selectedRepoId || !currentRepo) {
        const message = "No repo selected";
        if (!options?.silent) {
          showGitActionDialogSafely(message, "error");
        }
        return { success: false, message };
      }

      const success = await gitApi.gitDeleteBranch({
        repo_id: selectedRepoId,
        repo_path: currentRepo.path,
        branch_name: branchName,
      });

      if (!success) {
        const message = `Failed to delete branch "${branchName}"`;
        if (!options?.silent) {
          showGitActionDialogSafely(message, "error");
        }
        return { success: false, message };
      }

      if (!options?.silent) {
        showGitActionDialogSafely(`Branch "${branchName}" deleted`, "info");
      }
      if (!options?.skipRefresh) {
        await refreshBranches();
      }
      return { success: true };
    },
    [currentRepo, refreshBranches, selectedRepoId]
  );

  const handleRemoveWorktree = useCallback(
    async (
      worktreePath: string,
      options?: RemoveWorktreeOptions
    ): Promise<RemoveWorktreeResult> => {
      if (!selectedRepoId || !currentRepo) {
        const message = "No repo selected";
        if (!options?.silent) {
          showGitActionDialogSafely(message, "error");
        }
        return { success: false, message };
      }

      try {
        await removeGitWorktree({
          repo_id: selectedRepoId,
          repo_path: currentRepo.path,
          worktree_path: worktreePath,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!options?.silent) {
          showGitActionDialogSafely(message, "error");
        }
        return { success: false, message };
      }

      if (!options?.silent) {
        showGitActionDialogSafely(`Worktree "${worktreePath}" removed`, "info");
      }
      if (!options?.skipRefresh) {
        await refreshBranches();
      }
      return { success: true };
    },
    [currentRepo, refreshBranches, selectedRepoId]
  );

  const handleCheckoutDetached = useCallback(async () => {
    if (!selectedRepoId || !currentRepo) {
      showGitActionDialogSafely("No repo selected", "error");
      return;
    }

    // Route through the guarded checkout flow (selectBranch special-cases
    // HEAD-style refs) so a dirty tree surfaces the CheckoutConflictDialog
    // rather than bypassing it with a raw gitCheckout. selectBranch reports its
    // own failures; we keep the detached-HEAD success copy.
    await selectBranch("HEAD");

    showGitActionDialogSafely(
      t("selectors.branch.actions.checkoutDetachedSuccess"),
      "info"
    );
    await refreshBranches();
    setBranchPickerOpen(false);
    closeModal();
  }, [
    closeModal,
    currentRepo,
    refreshBranches,
    selectBranch,
    selectedRepoId,
    t,
  ]);

  useEffect(() => {
    if (isOpen) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setWorkspacePickerMode(null);
      setBranchPickerOpen(false);
      setAgentSessionSearchOpen(false);
      setAgentControlOpen(false);
      setSessionCreatorOpen(false);
      setEmbeddedEditorPalette(null);
      lastActivatedItemIdRef.current = null;
      setPendingRestoreItemId(null);
    });

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

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
      !agentSessionSearchOpen &&
      !agentControlOpen &&
      !sessionCreatorOpen,
    dispatch: spotlightDispatch,
    closeModal,
    onOpenWorkspaceLayer: handleOpenWorkspacePicker,
    onOpenBranchLayer: handleOpenBranchPicker,
    onOpenEditorLayer: handleOpenEditorPalette,
    onOpenAgentSessionSearchLayer: handleOpenAgentSessionSearch,
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
      !agentSessionSearchOpen &&
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
      agentSessionSearchOpen ||
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
    spotlight.items,
    workspacePickerMode,
    branchPickerOpen,
    agentSessionSearchOpen,
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
    agentSessionSearchOpen ||
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
      onRemoveWorktree={handleRemoveWorktree}
      onCheckoutDetached={handleCheckoutDetached}
      repoId={effectiveCurrentRepoId ?? ""}
      currentBranchName={selectedBranchName}
      asBody
      onModeChange={setEmbeddedBranchMode}
    />
  ) : agentSessionSearchOpen ? (
    <AgentSessionSearchPalette
      isOpen={isOpen}
      onClose={closeModal}
      onGoBackToParent={handleCloseAgentSessionSearch}
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
