/**
 * useSpotlight - Main Composition Hook
 *
 * Orchestrates all spotlight functionality with the new reducer architecture.
 * This is the single hook that components use to access all spotlight features.
 */
import { useAtomValue, useSetAtom } from "jotai";
import {
  type ComponentType,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from "react";

import {
  ACTION_ID,
  type ActionId,
  useActionSystemOptional,
} from "@src/ActionSystem";
import type { CloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";
import { useOpenCloudSessionReference } from "@src/features/Org2Cloud/useOpenCloudSessionReference";
import { useAppNavigation } from "@src/hooks/navigation/useAppNavigation";
import { showScaleMessage } from "@src/hooks/navigation/useGlobalShortcuts/types";
import { useFilteredItems } from "@src/hooks/search";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import type { LanguagePreference } from "@src/i18n";
import type { IconSvgElement } from "@src/icons";
import { checkForUpdatesManually } from "@src/scaffold/AppUpdater";
import {
  openAgentControlSpotlight,
  openSessionCreatorSpotlight,
} from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { AppViewService } from "@src/services/app";
import { PanelService } from "@src/services/panel";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import { selectedRepoAtom } from "@src/store/repo";
import { REPO_KIND } from "@src/store/repo/types";
import type { Session } from "@src/store/session";
import { spotlightRecentActionsAtom } from "@src/store/ui/spotlightRecentActionsAtom";
import { UI_SCALE_CONFIG, uiScaleAtom } from "@src/store/ui/uiAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { showInFinder } from "@src/util/platform/ipcRenderer";

import type { EditorPaletteMode } from "../palettes/EditorPalette/types";
import type {
  ActionDefinition,
  BranchItem,
  GlobalSpotlightProps,
  RepoItem,
} from "../types";
import { useSpotlightDispatch, useSpotlightState } from "./core";
import { useBranches, useSharedRepoList } from "./data";
import { useConfirmationPage, useSpotlightItems } from "./features";
import { addRecentActionId } from "./features/recentSpotlightActions";
import type {
  SpotlightEditorActionId,
  SpotlightStaticActionDefinition,
  SpotlightStaticActionFallback,
} from "./features/useSpotlightItems";

// ============================================
// Main Hook
// ============================================

function setUiScale(nextScale: number): void {
  const store = getInstrumentedStore();
  store.set(uiScaleAtom, nextScale);
  showScaleMessage(store.get(uiScaleAtom));
}

export function useSpotlight(
  props: GlobalSpotlightProps & {
    isOpen: boolean;
    closeModal?: () => void;
    onOpenWorkspacePicker?: (
      mode: "switch" | "open" | "add" | "create"
    ) => void;
    onOpenBranchPicker?: () => void;
    onOpenEditorPalette?: (prefix: string, mode?: EditorPaletteMode) => void;
    onOpenAgentSessionSearch?: () => void;
    onOpenAllSessionsSearch?: () => void;
    isEditorRoute?: boolean;
    isWorkStationRoute?: boolean;
    currentRepoId?: string;
  }
) {
  const {
    isOpen,
    closeModal,
    onOpenWorkspacePicker,
    onOpenBranchPicker,
    onOpenEditorPalette,
    onOpenAgentSessionSearch,
    onOpenAllSessionsSearch,
    isEditorRoute = false,
    isWorkStationRoute = false,
    currentRepoId,
  } = props;

  // Core state and dispatch
  const state = useSpotlightState();
  const currentRepo = useAtomValue(selectedRepoAtom);
  const { navigateTo } = useAppNavigation();
  const { openSession } = useSessionView();
  const openCloudSessionReference = useOpenCloudSessionReference();
  const actionSystem = useActionSystemOptional();
  const dispatch = useSpotlightDispatch();
  const setRecentActionIds = useSetAtom(spotlightRecentActionsAtom);

  // Shared repo list is only needed for action flows that ask the user to
  // choose a repo. The default Spotlight view no longer renders the repo list;
  // workspace switching is delegated to WorkspacePalette.
  const shouldFetchRepos = isOpen && state.missingParam === "repo";

  const activeRepoId = currentRepoId ?? currentRepo?.id;
  const { repos, filteredRepos, loadRepos, refreshReposForce } =
    useSharedRepoList(state.searchQuery);
  const sortedFilteredRepos = useMemo(() => {
    return [...filteredRepos].sort((repoA, repoB) => {
      if (repoA.id === activeRepoId) return -1;
      if (repoB.id === activeRepoId) return 1;
      return 0;
    });
  }, [activeRepoId, filteredRepos]);

  // Branches (lazy, only when needed)
  const { branches, fetchBranches } = useBranches({
    repoId: state.currentRepo?.id || null,
    enabled: state.missingParam === "branch",
  });

  // Branch filtering only — repo filtering lives inside useSharedRepoList.
  const { filteredItems: filteredBranches } = useFilteredItems({
    items: branches,
    searchQuery: state.searchQuery,
    getSearchText: (branch) => branch.name,
  });

  // Handlers (stable callbacks using dispatch)
  const handleSelectAction = useCallback(
    (action: ActionDefinition) => {
      dispatch({ type: "PUSH_ACTION", payload: { action } });
    },
    [dispatch]
  );

  const dispatchActionOrFallback = useCallback(
    (
      actionId: ActionId,
      payload: Record<string, unknown>,
      fallback?: () => void
    ) => {
      if (actionSystem?.isValidAction(actionId)) {
        void actionSystem.dispatch(actionId, payload, "user");
        return;
      }
      fallback?.();
    },
    [actionSystem]
  );

  const runStaticActionFallback = useCallback(
    (fallback: SpotlightStaticActionFallback) => {
      const fallbackHandlers: Record<
        SpotlightStaticActionFallback,
        () => void
      > = {
        "open-session-creator": openSessionCreatorSpotlight,
        "create-project": () => {
          void WorkStationViewService.openStationMode("my-station").then(
            async () => {
              const { openCreateTargetInChatPanelStartPageAtom } =
                await import("@src/store/chatPanel/chatPanelTabsAtom");
              const { CHAT_PANEL_CREATE_TARGET } =
                await import("@src/store/ui/chatPanelAtom");
              getInstrumentedStore().set(
                openCreateTargetInChatPanelStartPageAtom,
                {
                  target: CHAT_PANEL_CREATE_TARGET.PROJECT,
                }
              );
            }
          );
        },
        "create-work-item": () => {
          void WorkStationViewService.openStationMode("my-station").then(
            async () => {
              const { openCreateTargetInChatPanelStartPageAtom } =
                await import("@src/store/chatPanel/chatPanelTabsAtom");
              const { CHAT_PANEL_CREATE_TARGET } =
                await import("@src/store/ui/chatPanelAtom");
              getInstrumentedStore().set(
                openCreateTargetInChatPanelStartPageAtom,
                {
                  target: CHAT_PANEL_CREATE_TARGET.WORK_ITEM,
                }
              );
            }
          );
        },
        "search-agent-sessions": () => onOpenAgentSessionSearch?.(),
        "search-all-sessions": () => onOpenAllSessionsSearch?.(),
        "agent-control": openAgentControlSpotlight,
        "workspace-switch": () => onOpenWorkspacePicker?.("switch"),
        "workspace-add": () => onOpenWorkspacePicker?.("add"),
        "workspace-create": () => onOpenWorkspacePicker?.("create"),
        "branch-picker": () => onOpenBranchPicker?.(),
        "toggle-sidebar": () => {
          void AppViewService.toggleSidebar();
        },
        "zoom-in": () => {
          const store = getInstrumentedStore();
          setUiScale(
            Math.min(
              UI_SCALE_CONFIG.MAX,
              store.get(uiScaleAtom) + UI_SCALE_CONFIG.STEP
            )
          );
        },
        "zoom-out": () => {
          const store = getInstrumentedStore();
          setUiScale(
            Math.max(
              UI_SCALE_CONFIG.MIN,
              store.get(uiScaleAtom) - UI_SCALE_CONFIG.STEP
            )
          );
        },
        "zoom-reset": () => {
          setUiScale(UI_SCALE_CONFIG.DEFAULT);
        },
        "toggle-workstation-sidebar": () => {
          void WorkStationViewService.toggleWorkstationSidebar();
        },
        "toggle-bottom-panel": () => {
          PanelService.toggleBottomPanel();
        },
        "toggle-chat-focus": () => {
          void WorkStationViewService.toggleChatPanelMaximized();
        },
        "toggle-chat-panel": () => {
          void WorkStationViewService.showWorkStation();
        },
        "open-my-station": () => {
          void WorkStationViewService.openStationMode("my-station");
        },
        "open-agent-station": () => {
          void WorkStationViewService.openStationMode("agent-station");
        },
        "open-kanban": () => {
          void WorkStationViewService.openKanbanTab();
        },
        "open-search-sidebar": () => {
          void WorkStationViewService.openSearchSidebar();
        },
        "open-source-control-tab": () => {
          void WorkStationViewService.openSourceControlTab();
        },
        "open-terminal-tab": () => {
          void WorkStationViewService.openTerminalTab();
        },
        "detect-update": () => {
          void checkForUpdatesManually();
        },
      };

      fallbackHandlers[fallback]();
    },
    [
      onOpenAgentSessionSearch,
      onOpenAllSessionsSearch,
      onOpenBranchPicker,
      onOpenWorkspacePicker,
    ]
  );

  const handleSelectStaticAction = useCallback(
    (action: SpotlightStaticActionDefinition) => {
      const fallback = action.fallback;
      dispatchActionOrFallback(
        action.actionId,
        action.payload,
        fallback
          ? () => {
              runStaticActionFallback(fallback);
            }
          : undefined
      );

      // Recent action tracking
      setRecentActionIds((current) => addRecentActionId(current, action.id));

      if (action.closeOnSuccess) {
        closeModal?.();
      }

      dispatch({ type: "RESET_TO_IDLE" });
    },
    [
      closeModal,
      dispatch,
      dispatchActionOrFallback,
      runStaticActionFallback,
      setRecentActionIds,
    ]
  );

  const handleSelectEditorAction = useCallback(
    (actionId: SpotlightEditorActionId) => {
      const modeByAction: Record<SpotlightEditorActionId, EditorPaletteMode> = {
        "go-to-editor-file": "file",
        "run-editor-command": "command",
        "go-to-editor-symbol": "symbol",
      };
      const prefixByAction: Record<SpotlightEditorActionId, string> = {
        "go-to-editor-file": "",
        "run-editor-command": ">",
        "go-to-editor-symbol": "@",
      };

      onOpenEditorPalette?.(prefixByAction[actionId], modeByAction[actionId]);
      dispatch({ type: "RESET_TO_IDLE" });
    },
    [dispatch, onOpenEditorPalette]
  );

  const handleSelectRepo = useCallback(
    (repo: RepoItem) => {
      if (state.currentAction?.id === "show-in-finder") {
        const repoPath = repo.fs_uri?.replace(/^file:\/\//, "");
        if (!repoPath) return;

        dispatchActionOrFallback(
          ACTION_ID.FILE_REVEAL_IN_OS_FILE_MANAGER,
          { path: repoPath },
          () => {
            void showInFinder(repoPath);
          }
        );
        closeModal?.();
        dispatch({ type: "RESET_TO_IDLE" });
        return;
      }

      dispatch({ type: "PUSH_REPO", payload: { repo } });
      // Trigger branch fetch if action needs branches (git repos only)
      if (
        state.currentAction?.requiredParams.includes("branch") &&
        repo.kind !== REPO_KIND.FOLDER
      ) {
        fetchBranches(repo.id);
      }
    },
    [
      closeModal,
      dispatch,
      dispatchActionOrFallback,
      state.currentAction,
      fetchBranches,
    ]
  );

  const handleSelectBranch = useCallback(
    (branch: BranchItem) => {
      dispatch({
        type: "PUSH_BRANCH",
        payload: { branchName: branch.name, branchData: branch },
      });
    },
    [dispatch]
  );

  const handleSelectLanguage = useCallback(
    (language: LanguagePreference, label: string) => {
      dispatch({
        type: "PUSH_LANGUAGE",
        payload: { language, label },
      });
      dispatchActionOrFallback(ACTION_ID.SETTINGS_SET_LANGUAGE, { language });
      closeModal?.();
      dispatch({ type: "RESET_TO_IDLE" });
    },
    [closeModal, dispatch, dispatchActionOrFallback]
  );

  const handleSelectSession = useCallback(
    (session: Session, sessionName: string) => {
      openSession(session.session_id, sessionName, session.repoPath);
      closeModal?.();
      dispatch({ type: "RESET_TO_IDLE" });
    },
    [closeModal, dispatch, openSession]
  );

  const handleSelectCloudSessionReference = useCallback(
    (reference: CloudSessionReference) => {
      if (!openCloudSessionReference(reference, { autoReplay: true })) return;
      closeModal?.();
      dispatch({ type: "RESET_TO_IDLE" });
    },
    [closeModal, dispatch, openCloudSessionReference]
  );

  const handleSelectPath = useCallback(
    (
      path: string,
      label: string,
      _icon:
        | string
        | IconSvgElement
        | ComponentType<Record<string, unknown>>
        | undefined
    ) => {
      dispatchActionOrFallback(
        ACTION_ID.APP_NAVIGATE,
        { path, title: label },
        () => navigateTo(path)
      );
      closeModal?.();
      dispatch({ type: "RESET_TO_IDLE" });
    },
    [closeModal, dispatch, dispatchActionOrFallback, navigateTo]
  );

  // Items
  const { items } = useSpotlightItems(sortedFilteredRepos, filteredBranches, {
    onSelectAction: handleSelectAction,
    onSelectStaticAction: handleSelectStaticAction,
    onSelectEditorAction: handleSelectEditorAction,
    onSelectRepo: handleSelectRepo,
    onSelectBranch: handleSelectBranch,
    onSelectLanguage: handleSelectLanguage,
    onSelectSession: handleSelectSession,
    onSelectCloudSessionReference: handleSelectCloudSessionReference,
    onSelectPath: handleSelectPath,
    isEditorRoute,
    isWorkStationRoute,
  });

  // Confirmation page - execute action then reset
  // Note: nav destinations bypass confirmation and navigate immediately in handleSelectPath
  const handleExecute = useCallback(() => {
    closeModal?.();
    dispatch({ type: "RESET_TO_IDLE" });
  }, [dispatch, closeModal]);

  const confirmationPage = useConfirmationPage(handleExecute);

  const prevShouldFetchReposRef = useRef(false);
  const loadReposRef = useRef(loadRepos);

  useEffect(() => {
    loadReposRef.current = loadRepos;
  }, [loadRepos]);

  useEffect(() => {
    if (shouldFetchRepos && !prevShouldFetchReposRef.current) {
      loadReposRef.current();
    }
    prevShouldFetchReposRef.current = shouldFetchRepos;
  }, [shouldFetchRepos]);

  // Auto-transition to confirming stage when complete
  useEffect(() => {
    if (state.isComplete && state.stage === "selecting") {
      dispatch({ type: "START_CONFIRMING" });
    }
  }, [state.isComplete, state.stage, dispatch]);

  return {
    state,
    dispatch,
    repos,
    items,
    confirmationPage,
    refreshReposForce,
  };
}
