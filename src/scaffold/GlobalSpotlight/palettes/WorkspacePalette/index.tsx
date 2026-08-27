/**
 * WorkspacePalette Component
 *
 * Flat palette listing repos, folders, and workspaces as peers.
 * A workspace (multi-repo preset) renders as a single row showing
 * "{primary} Workspace" with a member list in the description.
 * Individual repos that belong to the active workspace are excluded
 * from the flat list to avoid duplication.
 *
 * Uses useSelectorKernel for unified state management.
 */
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { Search } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { repoApi } from "@src/api/tauri/repo";
import Message from "@src/components/Message";
import { cachedReposAtom } from "@src/store/repo";
import { addWorkspaceInitialStageAtom } from "@src/store/ui/overlayAtom";
import {
  isMultiRootWorkspaceAtom,
  setWorkspaceFoldersAtom,
} from "@src/store/ui/workspaceFoldersAtom";
import { confirmDestructiveAction } from "@src/util/dialogs/confirmDestructiveAction";

import {
  SPOTLIGHT_FOOTER_ACTIVE_CHIP,
  SpotlightPinnedActionSection,
} from "../../components";
import { ICONS } from "../../config";
import {
  type AddWorkspaceModalStage,
  EXTERNAL_RECENT_PATH_WORKSPACE_THRESHOLD,
  useAddWorkspaceFlow,
  useExternalRecentPaths,
  useSharedRepoList,
} from "../../hooks";
import { usePathSegment } from "../../hooks/usePathSegment";
import { PaletteBody, SpotlightShell } from "../../shell";
import type { RepoItem, SpotlightItem } from "../../types";
import { AddWorkspaceModalShell } from "../AddWorkspaceModalShell";
import { REPO_PALETTE_CONFIG } from "../config";
import { useSelectorKernel } from "../core";
import { buildOpenPathItem } from "./pathActionItem";
import { importWorkspacePath } from "./pathImport";
import { buildPinnedWorkspaceActions } from "./pinnedActions";
import type { AddMenuKind, WorkspacePaletteProps } from "./types";
import { useWorkspacePaletteNavigation } from "./useWorkspacePaletteNavigation";
import { useWorkspacePaletteWorkspace } from "./useWorkspacePaletteWorkspace";
import {
  buildSectionedAddItems,
  buildSectionedWorkspaceItems,
} from "./workspacePaletteItems";

// ============ COMPONENT ============

export const WorkspacePalette: React.FC<WorkspacePaletteProps> = ({
  isOpen,
  onClose,
  onSelect,
  currentRepoId,
  initialAddStage: initialAddStageProp,
  initialAddMenu = false,
  initialManageMode = false,
  topSlot,
  asBody = false,
  switchPathLabel,
  hideActionClose = false,
  leadingRepos = [],
  repoFilter,
  onGoBackToParent,
}) => {
  const { t } = useTranslation();

  // ============ GLOBAL STATE ============
  const [initialAddStageAtom, setInitialAddStageAtom] = useAtom(
    addWorkspaceInitialStageAtom
  );
  const effectiveInitialStage = initialAddStageProp ?? initialAddStageAtom;

  // ============ LOCAL STATE ============
  const [searchQuery, setSearchQuery] = useState("");
  const [modalStage, setModalStage] = useState<AddWorkspaceModalStage>(
    effectiveInitialStage ?? null
  );
  const [addMenuKind, setAddMenuKind] = useState<AddMenuKind>(
    effectiveInitialStage ? null : initialAddMenu ? "add" : null
  );
  const [isManageMode, setIsManageMode] = useState(initialManageMode);
  /** Set of selected item IDs in manage mode. Workspaces use the
   *  `workspace-${ws.workspaceId}` form; repos use the raw `repo.id`. */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());

  const paletteText = useMemo(
    () => ({
      switchPathLabel:
        switchPathLabel ??
        (isManageMode
          ? t("selectors.repo.path.manageWorkspace")
          : t("selectors.spotlight.actions.switchWorkspace.label")),
      switchPathTemplate: isManageMode
        ? t("selectors.repo.path.manageWorkspace")
        : t("selectors.spotlight.actions.switchWorkspace.label"),
      switchPlaceholder: t("selectors.spotlight.placeholders.workspace"),
      invalidPathTitle: t("selectors.repo.pathImport.invalidTitle"),
      invalidPathMessage: (path: string) =>
        t("selectors.repo.pathImport.invalidMessage", { path }),
      addPathLabel: t("selectors.spotlight.actions.addWorkspace.label"),
      addPathTemplate: t("selectors.repo.path.addByTemplate"),
      addPlaceholder: t("selectors.spotlight.placeholders.source"),
      addEntryLabel: t("selectors.repo.addEntry"),
      openFolderLabel: t("actions.openFolder"),
      addFolderLabel: t("selectors.repo.pathImport.addLabel"),
      sectionCurrentLabel: t("selectors.repo.sections.current"),
      sectionRecentLabel: t("selectors.repo.sections.recent", "Recent"),
      sectionSystemPathsLabel: t("selectors.repo.sections.systemPaths"),
      sectionExternalRecentLabel: t("selectors.repo.sections.usedElsewhere"),
      sectionRepoLabel: t("selectors.repo.sections.repo"),
      sectionFolderWorkspaceLabel: t("selectors.repo.sections.workspace"),
      sectionMultiRepoWorkspaceLabel: t(
        "workspaceForm.multiRepoWorkspace",
        "Multi-Repo Workspace"
      ),
      sectionThisOrgLabel: t("selectors.repo.sections.thisOrg", "This org"),
      sectionOutsideOrgLabel: t(
        "selectors.repo.sections.outsideOrg",
        "Outside this org"
      ),
    }),
    [t, isManageMode, switchPathLabel]
  );

  const wasOpenRef = React.useRef(false);

  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    let cancelled = false;

    if (isOpen) {
      wasOpenRef.current = true;

      Promise.resolve().then(() => {
        if (cancelled) return;

        if (effectiveInitialStage) {
          setModalStage(effectiveInitialStage);
          setAddMenuKind(null);
          setSearchQuery("");
          if (initialAddStageAtom) {
            setInitialAddStageAtom(null);
          }
        } else if (initialAddMenu) {
          setModalStage(null);
          setAddMenuKind("add");
          setSearchQuery("");
        } else if (!wasOpen) {
          setModalStage(null);
          setAddMenuKind(null);
        }

        if (initialManageMode) {
          setIsManageMode(true);
        }
      });
    }

    if (!isOpen && wasOpen) {
      wasOpenRef.current = false;
      Promise.resolve().then(() => {
        if (cancelled) return;
        setSearchQuery("");
        setModalStage(null);
        setAddMenuKind(null);
        setIsManageMode(false);
        setSelectedIds(new Set());
      });
    }

    return () => {
      cancelled = true;
    };
  }, [
    isOpen,
    effectiveInitialStage,
    initialAddMenu,
    initialManageMode,
    initialAddStageAtom,
    setInitialAddStageAtom,
  ]);

  // ============ DATA ============
  const { repos, filteredRepos, repoLoading, refreshReposForce } =
    useSharedRepoList({
      enabled: isOpen,
      currentRepoId,
      searchQuery,
    });
  const cachedRepos = useAtomValue(cachedReposAtom);

  const existingRepoPaths = useMemo(
    () => repos.map((repo) => repo.fs_uri ?? "").filter(Boolean),
    [repos]
  );

  const { recentPathRepos: externalRecentRepos } = useExternalRecentPaths({
    enabled:
      isOpen &&
      !isManageMode &&
      repos.length <= EXTERNAL_RECENT_PATH_WORKSPACE_THRESHOLD,
    existingRepoPaths,
    searchQuery,
  });

  // ============ MULTI-ROOT WORKSPACE ============
  const isMultiRoot = useAtomValue(isMultiRootWorkspaceAtom);
  const dispatchSetFolders = useSetAtom(setWorkspaceFoldersAtom);

  const handleRepoSelectWithWorkspaceExit = useCallback(
    (repoId: string, repo: RepoItem) => {
      if (isMultiRoot) {
        dispatchSetFolders([], null);
      }
      onSelect(repoId, repo);
      onClose();
    },
    [isMultiRoot, dispatchSetFolders, onSelect, onClose]
  );

  const handleAddedRepoSelect = useCallback(
    async (repoId?: string) => {
      if (!repoId) return;
      const result = await repoApi.getRepoById(repoId);
      const repo = result.data;
      const repoItem: RepoItem = {
        id: repo.repo_id,
        name: repo.name,
        fs_uri: repo.path,
        kind: repo.kind,
      };
      onSelect(repoItem.id, repoItem);
      onClose();
    },
    [onClose, onSelect]
  );

  // ============ ADD WORKSPACE FLOW ============
  const addWorkspaceFlow = useAddWorkspaceFlow({
    modalStage,
    setModalStage,
    onSuccess: handleAddedRepoSelect,
    onModalClose: () => {
      setModalStage(null);
    },
  });

  const handleExternalRecentSelect = useCallback(
    async (repo: RepoItem) => {
      const path = repo.fs_uri;
      if (!path) return;
      if (isMultiRoot) {
        dispatchSetFolders([], null);
      }
      await addWorkspaceFlow.localWorkspaceForm.handleImportWorkspace(path);
      await refreshReposForce();
    },
    [
      addWorkspaceFlow.localWorkspaceForm,
      dispatchSetFolders,
      isMultiRoot,
      refreshReposForce,
    ]
  );

  // ============ ITEMS ============
  const sectionedAddItems = useMemo(
    (): SpotlightItem[] =>
      buildSectionedAddItems(addWorkspaceFlow.addWorkspaceItems),
    [addWorkspaceFlow.addWorkspaceItems]
  );

  const toggleManageMode = useCallback(() => {
    setIsManageMode((prev) => {
      if (prev) {
        setSelectedIds(new Set());
        return false;
      }
      setSearchQuery("");
      return true;
    });
  }, []);

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const selectedCount = selectedIds.size;

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // ============ WORKSPACE MANAGEMENT ============
  const { workspaceItems, handleBulkDelete } = useWorkspacePaletteWorkspace({
    repos,
    isManageMode,
    selectedIds,
    toggleSelection,
    clearSelection,
    setModalStage,
    onClose,
    refreshReposForce,
    searchQuery,
    repoFilter,
    setEditingWorkspace:
      addWorkspaceFlow.multiRepoWorkspaceForm.setEditingWorkspace,
  });

  const addPathSegment = usePathSegment(
    REPO_PALETTE_CONFIG.modes?.find((mode) => mode.id === "add")?.path,
    {
      labelOverride: paletteText.addPathLabel,
      templateOverride: paletteText.addPathTemplate,
    }
  );

  const switchPathSegment = usePathSegment(
    REPO_PALETTE_CONFIG.modes?.find((mode) => mode.id === "switch")?.path,
    {
      labelOverride: paletteText.switchPathLabel,
      templateOverride: paletteText.switchPathTemplate,
      iconOverride: isManageMode ? Search : undefined,
    }
  );

  const handleRemoveRepo = useCallback(
    async (repo: RepoItem) => {
      const confirmed = await confirmDestructiveAction({
        title: t("confirmation.removeTitle", { name: repo.name }),
        message: t("confirmation.removeMessage"),
        okLabel: t("actions.removeFromOrgii", "Remove from ORGII"),
        cancelLabel: t("actions.cancel"),
      });
      if (!confirmed) return;

      try {
        await repoApi.deleteRepo(repo.id);
        await refreshReposForce();
        setSelectedIds((prev) => {
          if (!prev.has(repo.id)) return prev;
          const next = new Set(prev);
          next.delete(repo.id);
          return next;
        });
        Message.success(
          t("selectors.spotlight.toast.repoRemoved", "Linkage to ORGII removed")
        );
      } catch (error) {
        Message.error(
          error instanceof Error
            ? error.message
            : t(
                "selectors.spotlight.toast.repoRemoveFailed",
                "Failed to remove linkage to ORGII"
              )
        );
      }
    },
    [refreshReposForce, t]
  );

  const openPathItem = useMemo(
    () =>
      buildOpenPathItem({
        searchQuery,
        addLabel: paletteText.addFolderLabel,
        onOpenPath: (candidatePath) => {
          void importWorkspacePath({
            candidatePath,
            invalidPathTitle: paletteText.invalidPathTitle,
            invalidPathMessage: paletteText.invalidPathMessage,
            onImportWorkspace:
              addWorkspaceFlow.localWorkspaceForm.handleImportWorkspace,
          });
        },
      }),
    [
      addWorkspaceFlow.localWorkspaceForm.handleImportWorkspace,
      paletteText.invalidPathMessage,
      paletteText.invalidPathTitle,
      paletteText.addFolderLabel,
      searchQuery,
    ]
  );

  const pinnedActionItems = useMemo(
    (): SpotlightItem[] =>
      buildPinnedWorkspaceActions({
        isManageMode,
        selectedCount,
        paletteText,
        t,
        onOpenLocalWorkspace: () =>
          void addWorkspaceFlow.localWorkspaceForm.handleOpenLocalWorkspace(),
        onOpenAddMenu: () => setAddMenuKind("add"),
        onCreateWorkspace: () => setModalStage("create-workspace"),
        onBulkDelete: () => void handleBulkDelete(),
        onToggleManageMode: toggleManageMode,
      }),
    [
      addWorkspaceFlow.localWorkspaceForm,
      handleBulkDelete,
      isManageMode,
      paletteText,
      selectedCount,
      t,
      toggleManageMode,
    ]
  );

  const renderRepoTrashAction = useCallback(
    (repo: RepoItem): React.ReactNode => (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void handleRemoveRepo(repo);
        }}
        className="flex items-center justify-center rounded-md p-1 text-danger-6 transition-colors hover:bg-danger-6/10"
        title={t("actions.removeFromOrgii", "Remove from ORGII")}
      >
        <ICONS.removeRepo size={14} />
      </button>
    ),
    [handleRemoveRepo, t]
  );

  const mainItems = useMemo((): SpotlightItem[] => {
    return buildSectionedWorkspaceItems({
      addMenuActive: !!addMenuKind,
      sectionedAddItems,
      workspaceItems,
      openPathItem,
      filteredRepos,
      externalRecentRepos,
      recentCachedRepos: cachedRepos,
      currentRepoId,
      isMultiRoot,
      isManageMode,
      leadingRepos,
      selectedIds,
      searchQuery,
      paletteText,
      orgScopeFilter: repoFilter ?? null,
      onRepoAction: (repo) => {
        if (isManageMode) {
          toggleSelection(repo.id);
        } else {
          handleRepoSelectWithWorkspaceExit(repo.id, repo);
        }
      },
      onLeadingRepoAction: (repo) => {
        if (repo.id.startsWith("external-recent:")) {
          void handleExternalRecentSelect(repo);
        } else {
          handleRepoSelectWithWorkspaceExit(repo.id, repo);
        }
      },
      toggleSelection,
      renderRepoTrashAction,
    });
  }, [
    addMenuKind,
    cachedRepos,
    currentRepoId,
    externalRecentRepos,
    filteredRepos,
    handleExternalRecentSelect,
    handleRepoSelectWithWorkspaceExit,
    isManageMode,
    isMultiRoot,
    leadingRepos,
    openPathItem,
    paletteText,
    renderRepoTrashAction,
    repoFilter,
    searchQuery,
    sectionedAddItems,
    selectedIds,
    toggleSelection,
    workspaceItems,
  ]);

  const pinnedActionStartIndex = mainItems.length;
  const items = useMemo(
    () => (addMenuKind ? mainItems : [...mainItems, ...pinnedActionItems]),
    [addMenuKind, mainItems, pinnedActionItems]
  );

  // ============ KERNEL ============
  const isItemSelectable = useCallback((item: SpotlightItem) => {
    const data = item.data as Record<string, unknown> | undefined;
    return !data?.isHeader && !data?.disabled;
  }, []);

  const handleSectionTab = useCallback(
    (
      forward: boolean,
      selectedIndex: number,
      setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
    ) => {
      if (addMenuKind || pinnedActionItems.length === 0) return;

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
      addMenuKind,
      isItemSelectable,
      mainItems,
      pinnedActionItems.length,
      pinnedActionStartIndex,
    ]
  );

  const { handleGoBack, handleExternalKeyDown } = useWorkspacePaletteNavigation(
    {
      modalStage,
      addMenuKind,
      asBody,
      effectiveInitialStage,
      initialAddMenu,
      onClose,
      onGoBackToParent,
      setModalStage,
      setAddMenuKind,
      setSearchQuery,
      addWorkspaceFlow,
      searchQuery,
      paletteText,
    }
  );

  const kernel = useSelectorKernel({
    isOpen,
    onClose,
    items,
    isItemSelectable,
    hasModalState:
      !!modalStage || !!addMenuKind || asBody || !!onGoBackToParent,
    onGoBack: handleGoBack,
    onReset: () => {
      setSearchQuery("");
      if (effectiveInitialStage) {
        setModalStage(effectiveInitialStage);
        setAddMenuKind(null);
        return;
      }
      if (initialAddMenu) {
        setModalStage(null);
        setAddMenuKind("add");
        return;
      }
      setModalStage(null);
      setAddMenuKind(null);
    },
    externalSearchQuery: searchQuery,
    externalSetSearchQuery: setSearchQuery,
    externalHandleKeyDown: handleExternalKeyDown,
    onTab: handleSectionTab,
  });

  // ============ RENDER: MODAL VIEW ============
  if (modalStage && modalStage !== "add-workspace-existing") {
    return (
      <AddWorkspaceModalShell
        isOpen={isOpen}
        onClose={onClose}
        inputRef={kernel.inputRef}
        handleKeyDown={kernel.handleKeyDown}
        modalStage={modalStage}
        addWorkspaceFlow={addWorkspaceFlow}
        currentRepoId={currentRepoId}
        onGoBack={handleGoBack}
        asBody={asBody}
      />
    );
  }

  // ============ RENDER: PINNED ACTIONS ============
  const pinnedActionSection = addMenuKind ? undefined : (
    <SpotlightPinnedActionSection
      items={pinnedActionItems}
      startIndex={pinnedActionStartIndex}
      selectedIndex={kernel.selectedIndex}
      onItemSelect={kernel.handleItemClick}
      onItemHover={kernel.setSelectedIndex}
      searchQuery={searchQuery}
      layout="twoColumn"
    />
  );

  const handleRemovePathSegment = () => {
    if (addMenuKind) {
      setAddMenuKind(null);
      setSearchQuery("");
      return;
    }

    handleGoBack();
  };

  // ============ RENDER: MAIN VIEW ============
  const body = (
    <PaletteBody
      kernel={kernel}
      items={mainItems}
      placeholder={
        addMenuKind ? paletteText.addPlaceholder : paletteText.switchPlaceholder
      }
      path={addMenuKind ? addPathSegment : switchPathSegment}
      onRemoveSegment={handleRemovePathSegment}
      isLoading={repoLoading}
      hideActionClose={hideActionClose}
      containerHeight={350}
      topSlot={addMenuKind ? undefined : topSlot}
      afterListSlot={pinnedActionSection}
    />
  );

  if (asBody) return body;

  return (
    <SpotlightShell
      isOpen={isOpen}
      onClose={onClose}
      hasActiveAction={!addMenuKind && pinnedActionItems.length > 0}
      activeActionChip={SPOTLIGHT_FOOTER_ACTIVE_CHIP.switchSection}
    >
      {body}
    </SpotlightShell>
  );
};

WorkspacePalette.displayName = "WorkspacePalette";
