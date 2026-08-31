/**
 * SessionInfoLine Component
 *
 * Displays session configuration summary as a shared `PillGroup`:
 *   "[repo] | [location] | [branch]"  (resting, no border)
 * Hovering a segment promotes it to an independent pill and hides the
 * adjacent divider; the other segment stays transparent.
 *
 * Supports two repo-click modes via props:
 * - onRepoChange (switch): switches the Human Station workspace
 * - onRepoSelect (session-only): picks a repo for session creation only.
 *   Repo switch immediately also switches the Human Station workspace;
 *   branch is kept as-is (last used / checked-out).
 */
import type { RepoItem } from "@/src/scaffold/GlobalSpotlight/types";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { gitApi } from "@src/api/http/git";
import { CheckoutBlockedDialog } from "@src/components/GitDialogs/CheckoutBlockedDialog";
import { CheckoutConflictDialog } from "@src/components/GitDialogs/CheckoutConflictDialog";
import PillGroup from "@src/components/PillGroup";
import RunningLocationDropdownPanel from "@src/components/RunningLocationDropdownPanel";
import {
  RUNNING_LOCATIONS,
  type RunningLocation,
} from "@src/config/sessionCreatorConfig";
import {
  isSystemHomeRepoItem,
  isSystemPathRepoItem,
} from "@src/features/SessionCreator/utils/systemPathSource";
import { useActiveCloudOrgRepoFilter } from "@src/features/TeamCollaboration/useActiveCloudOrgRepoFilter";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { BranchPalette } from "@src/scaffold/GlobalSpotlight/palettes/BranchPalette";
import { BranchDropdown } from "@src/scaffold/GlobalSpotlight/palettes/BranchPalette/BranchDropdown";
import { WorkspacePalette } from "@src/scaffold/GlobalSpotlight/palettes/WorkspacePalette";
import { WorkspaceDropdown } from "@src/scaffold/GlobalSpotlight/palettes/WorkspacePalette/WorkspaceDropdown";
import { runGuardedCheckout } from "@src/services/git/operations/guardedCheckout";
import { REPO_KIND, type RepoKind } from "@src/store/repo/types";
import type {
  WorktreeLaunchSelection,
  WorktreeLaunchSource,
} from "@src/store/session/worktreeLaunchSourceAtom";
import { modelPickerStyleAtom } from "@src/store/ui/chatPanelAtom";
import {
  branchSelectorOpenAtom,
  locationSelectorOpenAtom,
  repoSelectorOpenAtom,
} from "@src/store/ui/overlayAtom";
import { isMultiRootWorkspaceAtom } from "@src/store/ui/workspaceFoldersAtom";
import { workspaceNameAtom } from "@src/store/workspace/derived";
import { showGitActionDialogSafely } from "@src/util/dialogs/gitActionDialog";

import {
  buildSessionInfoSegments,
  getSessionInfoDisplayState,
} from "./SessionInfoLine/buildSessionInfoSegments";
import { type LocationRow } from "./SessionInfoLine/locationConfig";
import { useSystemPathRepoItems } from "./SessionInfoLine/useSystemPathRepoItems";
import WorktreeSourceSelector from "./WorktreeSourceSelector";

// ============================================
// Type Definitions
// ============================================

export interface SessionInfoLineProps {
  /** Current repository ID */
  repoId?: string;
  /** Current repository name */
  repoName?: string;
  /** Current repository path (fs_uri) - needed for branch fetching */
  repoPath?: string;
  /**
   * Switch-workspace handler. Selecting a repo updates the Human Station
   * workspace atom AND the session source. Optional when `disabled` is
   * true (read-only mode used by post-launch surfaces).
   */
  onRepoChange?: (repoId: string, options?: { repoKind?: RepoKind }) => void;
  /**
   * Session-only handler. When provided, selecting a repo calls this
   * (updates session source only). After branch is picked, a follow-up
   * selector asks whether to switch the workspace too.
   * If absent, onRepoChange is used directly.
   */
  onRepoSelect?: (repoId: string, repo: RepoItem) => void;
  /** Local/Git source kind — `folder` hides branch UI */
  repoKind?: RepoKind;
  /** Whether to include system path sources in the source selector. */
  includeSystemPaths?: boolean;
  /** Current branch name */
  branchName?: string;
  /** Handler for branch change. Optional when `disabled` is true. */
  onBranchChange?: (branch: string) => void;
  /** Whether branches are loading */
  branchLoading?: boolean;
  /**
   * Read-only mode: pills render with disabled styling and clicks are
   * suppressed (no selectors open). Used by post-launch surfaces where
   * repo / branch / location are immutable.
   */
  disabled?: boolean;
  /**
   * Suppress the branch segment regardless of `repoKind`. Used in
   * read-only post-launch contexts where branch is locked and not
   * interesting to display.
   */
  hideBranch?: boolean;
  /**
   * When true, the row sits in a full-width SessionCreator surface (e.g. the
   * fullScreen ChatPanel creator) immediately under the composer input.
   */
  fullWidth?: boolean;
  /** Direction used by anchored repo, branch, and location menus. */
  dropdownDirection?: "up" | "down";
  /**
   * When provided, adds a third segment for selecting the running location
   * (This Mac / New Worktree / Cloud) — modelled after Cursor's context bar.
   */
  worktreeLocation?: RunningLocation;
  selectedWorktreePath?: string | null;
  worktreeLocationLabel?: string;
  worktreeSourceLabel?: string;
  worktreeSource?: WorktreeLaunchSource | null;
  onWorktreeLocationChange?: (location: RunningLocation) => void;
  onWorktreeSourceSelect?: (selection: WorktreeLaunchSelection) => void;
  /** Optional control rendered before the repository, location, and branch pills. */
  leadingContent?: React.ReactNode;
}

const LOCATION_ROWS: LocationRow[] = RUNNING_LOCATIONS.map((entry) => ({
  id: entry.id,
  disabled: entry.disabled === true,
}));

function getLocationRow(location: RunningLocation): LocationRow {
  return (
    LOCATION_ROWS.find((row) => row.id === location) ?? {
      id: location,
      disabled: false,
    }
  );
}

interface SelectorShortcutBridgeState {
  disabled: boolean;
  showBranchRow: boolean;
  repoId?: string;
  worktreeLocation?: RunningLocation;
  isLocationDropdownOpen: boolean;
  openLocationSelector: () => void;
}

interface SelectorShortcutBridgeParams extends SelectorShortcutBridgeState {
  openBranchSelector: () => void;
  openRepoSelector: () => void;
}

function useSelectorShortcutBridge({
  disabled,
  showBranchRow,
  repoId,
  worktreeLocation,
  isLocationDropdownOpen,
  openLocationSelector,
  openBranchSelector,
  openRepoSelector,
}: SelectorShortcutBridgeParams): void {
  const store = useStore();
  const setGlobalBranchSelectorOpen = useSetAtom(branchSelectorOpenAtom);
  const setGlobalRepoSelectorOpen = useSetAtom(repoSelectorOpenAtom);
  const setGlobalLocationSelectorOpen = useSetAtom(locationSelectorOpenAtom);

  // Latest gating flags + handlers accessed from the store subscription.
  // The subscription registers once per `store` instance; without a ref we
  // would have to re-subscribe on every prop change. The ref body is
  // refreshed in an effect (writing `.current` in render is disallowed by
  // the React Compiler `refs` rule).
  const bridgeStateRef = useRef<SelectorShortcutBridgeState>({
    disabled,
    showBranchRow,
    repoId,
    worktreeLocation,
    isLocationDropdownOpen,
    openLocationSelector,
  });

  useEffect(() => {
    bridgeStateRef.current = {
      disabled,
      showBranchRow,
      repoId,
      worktreeLocation,
      isLocationDropdownOpen,
      openLocationSelector,
    };
  });

  // Bridge global shortcut atoms (⌘., ⌥⌘., ⇧⌘.) → local dropdown state.
  // The atoms behave as one-shot signals: a shortcut handler flips them to
  // true, this component consumes the edge, opens the matching dropdown,
  // and flips the atom back to false so a second press re-triggers.
  //
  // We subscribe to the Jotai store directly (outside the React render
  // tree) rather than reading the atom via `useAtomValue` + `useEffect`.
  // That avoids the React Compiler `set-state-in-effect` rule, because
  // the setState calls run from a store subscription callback — the same
  // category as a DOM event listener — instead of synchronously inside a
  // render effect.
  useEffect(() => {
    const unsubBranch = store.sub(branchSelectorOpenAtom, () => {
      if (!store.get(branchSelectorOpenAtom)) return;
      setGlobalBranchSelectorOpen(false);
      const s = bridgeStateRef.current;
      if (s.disabled || !s.showBranchRow || !s.repoId) return;
      openBranchSelector();
    });
    const unsubRepo = store.sub(repoSelectorOpenAtom, () => {
      if (!store.get(repoSelectorOpenAtom)) return;
      setGlobalRepoSelectorOpen(false);
      const s = bridgeStateRef.current;
      if (s.disabled) return;
      openRepoSelector();
    });
    const unsubLocation = store.sub(locationSelectorOpenAtom, () => {
      if (!store.get(locationSelectorOpenAtom)) return;
      setGlobalLocationSelectorOpen(false);
      const s = bridgeStateRef.current;
      if (s.disabled || s.worktreeLocation === undefined) return;
      if (s.isLocationDropdownOpen) return;
      s.openLocationSelector();
    });
    return () => {
      unsubBranch();
      unsubRepo();
      unsubLocation();
    };
  }, [
    store,
    setGlobalBranchSelectorOpen,
    setGlobalRepoSelectorOpen,
    setGlobalLocationSelectorOpen,
    openBranchSelector,
    openRepoSelector,
  ]);
}

// ============================================
// Component
// ============================================

const SessionInfoLine: React.FC<SessionInfoLineProps> = ({
  repoId,
  repoName,
  repoPath,
  onRepoChange,
  onRepoSelect,
  repoKind,
  includeSystemPaths = false,
  branchName,
  onBranchChange,
  branchLoading,
  fullWidth: _fullWidth = false,
  dropdownDirection = "down",
  worktreeLocation,
  selectedWorktreePath,
  worktreeLocationLabel,
  worktreeSourceLabel,
  worktreeSource,
  onWorktreeLocationChange,
  onWorktreeSourceSelect,
  leadingContent,
  disabled = false,
  hideBranch = false,
}) => {
  const { t } = useTranslation();

  // ============================================
  // Selector State
  // ============================================

  const [isRepoSelectorOpen, setIsRepoSelectorOpen] = useState(false);
  const [isBranchSelectorOpen, setIsBranchSelectorOpen] = useState(false);

  // Forward declaration: the actual `close` comes back from
  // `useDropdownEngine` below, but `handleLocationRowSelect` needs to
  // close the dropdown after committing. We route through a ref to
  // avoid a circular initialization.
  const closeLocationRef = useRef<() => void>(() => undefined);

  const handleLocationRowSelect = useCallback(
    (row: LocationRow) => {
      onWorktreeLocationChange?.(row.id);
      closeLocationRef.current();
      setIsBranchSelectorOpen(false);
      if (row.id === "worktree" && onWorktreeSourceSelect) {
        queueMicrotask(() => setIsBranchSelectorOpen(true));
      }
    },
    [onWorktreeLocationChange, onWorktreeSourceSelect]
  );

  const {
    isOpen: isLocationDropdownOpen,
    isPositioned: isLocationPositioned,
    toggle: toggleLocation,
    close: closeLocation,
    triggerRef: locationTriggerRef,
    panelRef: locationPanelRef,
    panelPosition: locationPanelPosition,
    keyboard: locationKeyboard,
  } = useDropdownEngine<HTMLButtonElement, LocationRow>({
    gap: 6,
    align: "left",
    placement: dropdownDirection === "up" ? "top" : "bottom",
    listNavigation: {
      items: LOCATION_ROWS,
      onSelect: handleLocationRowSelect,
      isItemSelectable: (row) => !row.disabled,
    },
  });
  useEffect(() => {
    closeLocationRef.current = closeLocation;
  }, [closeLocation]);

  // ============================================
  // Anchored dropdown refs (used when modelPickerStyle === "dropdown")
  // ============================================

  const repoTriggerRef = useRef<HTMLButtonElement>(null);
  const branchTriggerRef = useRef<HTMLButtonElement>(null);
  const modelPickerStyle = useAtomValue(modelPickerStyleAtom);
  const useDropdownPicker = modelPickerStyle === "dropdown";

  // ============================================
  // Handlers
  // ============================================

  const handleRepoTriggerClick = useCallback(() => {
    if (disabled) return;
    closeLocation();
    setIsBranchSelectorOpen(false);
    setIsRepoSelectorOpen((isOpen) => !isOpen);
  }, [closeLocation, disabled]);

  const handleBranchTriggerClick = useCallback(() => {
    if (disabled) return;
    closeLocation();
    setIsRepoSelectorOpen(false);
    setIsBranchSelectorOpen((isOpen) => !isOpen);
  }, [closeLocation, disabled]);

  const handleRepoSelected = useCallback(
    (selectedRepoId: string, repo: RepoItem) => {
      if (isSystemPathRepoItem(repo)) {
        onRepoSelect?.(selectedRepoId, repo);
        setIsRepoSelectorOpen(false);
        return;
      }

      const kind = (repo.kind as RepoKind) ?? REPO_KIND.GIT;
      onRepoSelect?.(selectedRepoId, repo);
      onRepoChange?.(selectedRepoId, { repoKind: kind });
      setIsRepoSelectorOpen(false);
    },
    [onRepoSelect, onRepoChange]
  );

  const systemPathSourceItems = useSystemPathRepoItems(includeSystemPaths, t);
  const branchRepoPath = selectedWorktreePath ?? repoPath ?? "";

  // The org scope predicate no longer hides or reassigns the selection:
  // the pickers group rows into "This org" / "Outside this org" instead,
  // and out-of-scope repos are legitimate picks (they simply launch
  // without the org tag — autoTagLaunchedSessionToActiveCloudOrg guards).
  const orgScopeRepoFilter = useActiveCloudOrgRepoFilter();

  const handleBranchSelect = useCallback(
    async (branch: string) => {
      if (!repoId || !branchRepoPath || repoKind === REPO_KIND.FOLDER) {
        onBranchChange?.(branch);
        setIsBranchSelectorOpen(false);
        return true;
      }

      const result = await runGuardedCheckout({
        repoId,
        repoPath: branchRepoPath,
        ref: branch,
        onConflict: (name) => CheckoutConflictDialog.open({ branchName: name }),
        onBlocked: ({ branch: name, errorType, message }) =>
          CheckoutBlockedDialog.open({
            branchName: name,
            errorType,
            message,
          }),
      });

      if (result.success) {
        onBranchChange?.(branch);
        if (result.outcome !== "checked-out" && result.message) {
          showGitActionDialogSafely(result.message, "info");
        }
        setIsBranchSelectorOpen(false);
        return true;
      }

      if (result.outcome !== "cancelled" && !result.blocked) {
        showGitActionDialogSafely(
          result.message || `Failed to checkout branch "${branch}"`,
          "error"
        );
      }
      return false;
    },
    [branchRepoPath, onBranchChange, repoId, repoKind]
  );

  const handleBranchPaletteSelect = useCallback(
    async (branch: string) => {
      return handleBranchSelect(branch);
    },
    [handleBranchSelect]
  );

  const handleCreateBranch = useCallback(
    async (branch: string, startPoint?: string) => {
      if (!repoId || !branchRepoPath) return;
      const result = await gitApi.gitCreateBranch({
        repo_id: repoId,
        repo_path: branchRepoPath,
        name: branch,
        start_point: startPoint ?? null,
        checkout: false,
      });
      if (!result.success) {
        showGitActionDialogSafely(
          result.error || `Failed to create branch "${branch}"`,
          "error"
        );
        return;
      }
      await handleBranchSelect(branch);
    },
    [branchRepoPath, handleBranchSelect, repoId]
  );

  const handleDeleteBranch = useCallback(
    async (
      branch: string,
      options?: { silent?: boolean; skipRefresh?: boolean }
    ) => {
      if (!repoId || !branchRepoPath) {
        const message = "No repo selected";
        if (!options?.silent) {
          showGitActionDialogSafely(message, "error");
        }
        return { success: false, message };
      }

      const result = await gitApi.gitDeleteBranch({
        repo_id: repoId,
        repo_path: branchRepoPath,
        branch_name: branch,
      });

      if (!result.success) {
        const message = result.error || `Failed to delete branch "${branch}"`;
        if (!options?.silent) {
          showGitActionDialogSafely(message, "error");
        }
        return { success: false, message };
      }

      if (!options?.silent) {
        showGitActionDialogSafely(`Branch "${branch}" deleted`, "info");
      }
      return { success: true };
    },
    [branchRepoPath, repoId]
  );

  const handleBranchClose = useCallback(() => {
    setIsBranchSelectorOpen(false);
  }, []);

  const handleRepoClose = useCallback(() => {
    setIsRepoSelectorOpen(false);
  }, []);

  const handleLocationPanelSelect = useCallback(
    (location: RunningLocation) => {
      handleLocationRowSelect(getLocationRow(location));
    },
    [handleLocationRowSelect]
  );

  // ============================================
  // Display
  // ============================================

  const isMultiRoot = useAtomValue(isMultiRootWorkspaceAtom);
  const workspaceName = useAtomValue(workspaceNameAtom);

  const currentRepoItem = useMemo(
    () => ({
      id: repoId ?? "",
      name: repoName ?? "",
      kind: repoKind,
    }),
    [repoId, repoName, repoKind]
  );
  const isSystemPath =
    includeSystemPaths && isSystemPathRepoItem(currentRepoItem);
  const isSystemHome =
    includeSystemPaths && isSystemHomeRepoItem(currentRepoItem);

  const { sourceDisplayName, SourceIcon, hasSource, showBranchRow } = useMemo(
    () =>
      getSessionInfoDisplayState({
        isMultiRoot,
        workspaceName,
        repoName,
        repoKind,
        isSystemPathSource: isSystemPath,
        isSystemHomeSource: isSystemHome,
        hideBranch,
        t,
      }),
    [
      isMultiRoot,
      workspaceName,
      repoName,
      repoKind,
      isSystemPath,
      isSystemHome,
      hideBranch,
      t,
    ]
  );

  const openLocationSelector = useCallback(() => {
    setIsRepoSelectorOpen(false);
    setIsBranchSelectorOpen(false);
    toggleLocation();
  }, [toggleLocation]);

  const handleLocationTriggerClick = useCallback(() => {
    if (disabled) return;
    openLocationSelector();
  }, [disabled, openLocationSelector]);

  const openRepoSelector = useCallback(() => {
    closeLocation();
    setIsBranchSelectorOpen(false);
    setIsRepoSelectorOpen(true);
  }, [closeLocation]);

  const openBranchSelector = useCallback(() => {
    closeLocation();
    setIsRepoSelectorOpen(false);
    setIsBranchSelectorOpen(true);
  }, [closeLocation]);

  useSelectorShortcutBridge({
    disabled,
    showBranchRow,
    repoId,
    worktreeLocation,
    isLocationDropdownOpen,
    openLocationSelector,
    openBranchSelector,
    openRepoSelector,
  });

  const baseSegments = buildSessionInfoSegments({
    SourceIcon,
    hasSource,
    sourceDisplayName,
    isRepoSelectorOpen,
    handleRepoTriggerClick,
    showBranchRow,
    branchLoading,
    branchName,
    isBranchSelectorOpen,
    handleBranchTriggerClick,
    worktreeLocation,
    worktreeLocationLabel,
    worktreeSourceLabel,
    isLocationDropdownOpen,
    handleLocationTriggerClick,
    locationTriggerRef,
    disabled,
    t,
  });

  // Attach refs out-of-band so the React Compiler `refs` rule doesn't
  // flag passing locally-created refs through a plain function.
  const segments = baseSegments.map((segment) => {
    if (segment.id === "repo") return { ...segment, buttonRef: repoTriggerRef };
    if (segment.id === "branch")
      return { ...segment, buttonRef: branchTriggerRef };
    return segment;
  });

  const sessionInfoPills = (
    <PillGroup segments={segments} className="flex-wrap" strongSurface />
  );

  return (
    <>
      {leadingContent ? (
        <div className="inline-flex flex-wrap items-center gap-0">
          {leadingContent}
          <span
            aria-hidden
            className="inline-flex h-3 w-px shrink-0 bg-border-2"
          />
          {sessionInfoPills}
        </div>
      ) : (
        sessionInfoPills
      )}

      {/* Repo Selector */}
      {useDropdownPicker ? (
        <WorkspaceDropdown
          isOpen={isRepoSelectorOpen}
          onClose={handleRepoClose}
          onSelect={handleRepoSelected}
          currentRepoId={repoId}
          anchorRef={repoTriggerRef}
          placement={dropdownDirection === "up" ? "top" : "bottom"}
          leadingRepos={systemPathSourceItems}
          repoFilter={orgScopeRepoFilter ?? undefined}
        />
      ) : (
        <WorkspacePalette
          isOpen={isRepoSelectorOpen}
          onClose={handleRepoClose}
          onSelect={handleRepoSelected}
          currentRepoId={repoId}
          switchPathLabel={t("selectors.sessionInfo.sessionWorkspace")}
          hideActionClose
          leadingRepos={systemPathSourceItems}
          repoFilter={orgScopeRepoFilter ?? undefined}
        />
      )}

      {/* Branch Selector */}
      {showBranchRow &&
        repoId &&
        (worktreeLocation === "worktree" && onWorktreeSourceSelect ? (
          isBranchSelectorOpen ? (
            <WorktreeSourceSelector
              key={repoId || repoPath}
              isOpen
              presentation={useDropdownPicker ? "dropdown" : "spotlight"}
              onClose={handleBranchClose}
              onSelect={onWorktreeSourceSelect}
              repoId={repoId}
              repoPath={repoPath}
              currentBranchName={branchName}
              selectedSource={worktreeSource}
              anchorRef={branchTriggerRef}
              placement={dropdownDirection === "up" ? "top" : "bottom"}
            />
          ) : null
        ) : useDropdownPicker ? (
          <BranchDropdown
            isOpen={isBranchSelectorOpen}
            onClose={handleBranchClose}
            onSelect={handleBranchSelect}
            repoId={repoId}
            repoPath={branchRepoPath}
            currentBranchName={branchName}
            groupWorktreeBranches={false}
            anchorRef={branchTriggerRef}
            placement={dropdownDirection === "up" ? "top" : "bottom"}
          />
        ) : (
          <BranchPalette
            isOpen={isBranchSelectorOpen}
            onClose={handleBranchClose}
            onSelect={handleBranchPaletteSelect}
            repoId={repoId}
            repoPath={branchRepoPath}
            currentBranchName={branchName}
            groupWorktreeBranches={false}
            onCreateBranch={handleCreateBranch}
            onDeleteBranch={handleDeleteBranch}
            variant="create-session"
            showRemoveMode
            hideActionClose
          />
        ))}

      {/* Location dropdown portal */}
      {worktreeLocation !== undefined &&
        isLocationDropdownOpen &&
        isLocationPositioned &&
        createPortal(
          <RunningLocationDropdownPanel
            panelRef={locationPanelRef}
            style={{
              position: "fixed",
              top: locationPanelPosition.top,
              bottom: locationPanelPosition.bottom,
              left: locationPanelPosition.left,
            }}
            selected={worktreeLocation}
            getItemProps={locationKeyboard.getItemProps}
            onSelect={handleLocationPanelSelect}
          />,
          document.body
        )}
    </>
  );
};

export default SessionInfoLine;
