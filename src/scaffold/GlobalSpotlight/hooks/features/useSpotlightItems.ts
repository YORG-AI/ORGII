/**
 * useSpotlightItems Hook (Pure Derivation)
 *
 * Pure function that derives items to display from state.
 * No internal state, no callbacks — only data transformation.
 *
 * Composition:
 *   - Action definitions      → `spotlightActionDefinitions.ts`
 *   - Item builder primitives → `spotlightItemBuilders.ts`
 *   - Search-mode item logic  → `spotlightSearchBuilder.ts`
 *   - Domain adapters         → `../../palettes/adapters`
 *
 * Uses shared domain adapters for repo/branch item building.
 */
import { useAtomValue } from "jotai";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { GlobalThemePreference } from "@src/config/appearance/globalThemes";
import type { SkinVariant } from "@src/config/appearance/skins/types";
import type { CloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { org2CloudRemoteSessionsAtom } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { useFilteredItems } from "@src/hooks/search";
import type { LanguagePreference } from "@src/i18n";
import { devModeEnabledAtom } from "@src/store/platform/devModeAtom";
import {
  type Session,
  sessionsAtom,
  visitedSessionsAtom,
} from "@src/store/session";
import {
  chatPanelMaximizedAtom,
  chatTurnPaginationEnabledAtom,
  chatVisibleAtom,
  modelPickerStyleAtom,
} from "@src/store/ui/chatPanelAtom";
import { languageAtom } from "@src/store/ui/languageAtom";
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";
import { spotlightRecentActionsAtom } from "@src/store/ui/spotlightRecentActionsAtom";
import {
  activeSkinIdAtom,
  globalThemeIdAtom,
  skinVariantAtom,
  systemColorSchemeAtom,
} from "@src/store/ui/uiAtom";
import {
  chatPanelPositionAtom,
  workStationEditorSecondaryCollapsedAtom,
  workStationLayoutModeAtom,
  workStationPrimarySidebarCollapsedAtom,
} from "@src/store/ui/workStationAtom";
import { activeStatusBarCallbacksAtom } from "@src/store/ui/workStationLayout/statusBarAtoms";
import { getSessionSearchText } from "@src/util/session/sessionSearch";

import { NAV_DESTINATIONS } from "../../config";
import {
  buildBranchSpotlightItems,
  buildRepoSpotlightItems,
  sortRepoItemsSelectedFirst,
} from "../../palettes/adapters";
import type {
  ActionDefinition,
  BranchItem,
  RepoItem,
  SpotlightItem,
} from "../../types";
import { useSpotlightState } from "../core";
import type { UseSpotlightItemsReturn } from "../core/types";
import { resolveRecentDefinitions } from "./recentSpotlightActions";
import {
  AGENT_SESSION_ACTIONS,
  APP_ACTIONS,
  ORGANIZATION_ACTIONS,
  QUICK_NAVIGATION_ACTIONS,
  STATION_MODE_ACTIONS,
  type SpotlightEditorActionId,
  type SpotlightStaticActionDefinition,
  WORKSPACE_ACTIONS,
  buildChatPanelSettingsActions,
  buildViewActions,
} from "./spotlightActionDefinitions";
import {
  type Translator,
  buildActionItems,
  buildEditorActionItems,
  buildGroupedDefaultItems,
  buildLanguageItems,
  buildNavDestinationItem,
  buildRepoActionItems,
  buildSkinItems,
  buildStaticActionItems,
  buildThemeItems,
} from "./spotlightItemBuilders";
import { buildSearchModeItems } from "./spotlightSearchBuilder";
import {
  buildCloudSessionReferenceItem,
  buildSpotlightSessionItems,
  resolveAgentSessionSearchInput,
  resolveSpotlightCloudSessionPresentation,
} from "./spotlightSessionSearch";

const GENERAL_SPOTLIGHT_SESSION_RESULT_LIMIT = 8;

// ============================================
// Public type re-exports
// ============================================
//
// `useSpotlight.ts` and other callers import these types directly from
// `./features/useSpotlightItems`. Keep the re-exports here so the public
// surface of this module is stable after the internal refactor.

export type {
  SpotlightEditorActionId,
  SpotlightStaticActionDefinition,
  SpotlightStaticActionFallback,
  SpotlightStaticActionId,
} from "./spotlightActionDefinitions";

// ============================================
// Hook implementation
// ============================================

interface SpotlightItemsHandlers {
  onSelectAction: (action: ActionDefinition) => void;
  onSelectStaticAction: (action: SpotlightStaticActionDefinition) => void;
  onSelectEditorAction: (actionId: SpotlightEditorActionId) => void;
  onSelectRepo: (repo: RepoItem) => void;
  onSelectBranch: (branch: BranchItem) => void;
  onSelectLanguage: (language: LanguagePreference, label: string) => void;
  onSelectTheme: (theme: GlobalThemePreference) => void;
  onSelectSkin: (skinId: string, variant: SkinVariant) => void;
  onSelectSession: (session: Session, sessionName: string) => void;
  onSelectCloudSessionReference: (reference: CloudSessionReference) => void;
  onSelectPath: (
    path: string,
    label: string,
    icon: SpotlightItem["icon"]
  ) => void;
  currentRepoId?: string;
  isEditorRoute: boolean;
  isWorkStationRoute: boolean;
}

export function useSpotlightItems(
  filteredRepos: RepoItem[],
  filteredBranches: BranchItem[],
  handlers: SpotlightItemsHandlers
): UseSpotlightItemsReturn {
  const state = useSpotlightState();
  const isSidebarCollapsed = useAtomValue(sidebarCollapsedAtom);
  const fallbackWorkstationSidebarCollapsed = useAtomValue(
    workStationPrimarySidebarCollapsedAtom
  );
  const activeStatusBarCallbacks = useAtomValue(activeStatusBarCallbacksAtom);
  const isWorkstationSidebarCollapsed =
    activeStatusBarCallbacks.primaryPanelCollapsed ??
    fallbackWorkstationSidebarCollapsed;
  const isBottomPanelCollapsed = useAtomValue(
    workStationEditorSecondaryCollapsedAtom
  );
  const isChatPanelMaximized = useAtomValue(chatPanelMaximizedAtom);
  const isChatPanelVisible = useAtomValue(chatVisibleAtom);
  const globalThemeId = useAtomValue(globalThemeIdAtom);
  const systemColorScheme = useAtomValue(systemColorSchemeAtom);
  const activeSkinId = useAtomValue(activeSkinIdAtom);
  const skinVariant = useAtomValue(skinVariantAtom);
  const chatPanelPosition = useAtomValue(chatPanelPositionAtom);
  const chatTurnPaginationEnabled = useAtomValue(chatTurnPaginationEnabledAtom);
  const modelPickerStyle = useAtomValue(modelPickerStyleAtom);
  const devModeEnabled = useAtomValue(devModeEnabledAtom);
  const workstationSidebarPosition = useAtomValue(workStationLayoutModeAtom);
  const currentLanguage = useAtomValue(languageAtom);
  const recentActionIds = useAtomValue(spotlightRecentActionsAtom);
  const sessions = useAtomValue(sessionsAtom);
  const visitedSessions = useAtomValue(visitedSessionsAtom);
  const cloudAuth = useAtomValue(org2CloudAuthAtom);
  const cloudRemoteSessions = useAtomValue(org2CloudRemoteSessionsAtom);
  const { t } = useTranslation();
  const translate: Translator = t;

  const {
    onSelectAction,
    onSelectStaticAction,
    onSelectEditorAction,
    onSelectRepo,
    onSelectBranch,
    onSelectLanguage,
    onSelectTheme,
    onSelectSkin,
    onSelectSession,
    onSelectCloudSessionReference,
    onSelectPath,
    currentRepoId,
    isEditorRoute,
    isWorkStationRoute,
  } = handlers;

  // Extract specific fields to narrow memo dependencies. Previously this
  // depended on the entire state object, causing recomputation on any state
  // change (e.g. selectedIndex).
  const { stage, path, currentAction, missingParam, searchQuery, isComplete } =
    state;
  const hasAction = path.some((segment) => segment.type === "action");
  const hasRepo = path.some((segment) => segment.type === "repo");
  const isGeneralSearch = Boolean(searchQuery) && !hasAction && !hasRepo;
  const resolvedSessionSearchInput = useMemo(
    () => resolveAgentSessionSearchInput(searchQuery),
    [searchQuery]
  );
  const generalSessionSearchQuery = isGeneralSearch
    ? resolvedSessionSearchInput.query
    : "";
  const sortedSessions = useMemo(() => {
    if (!isGeneralSearch || resolvedSessionSearchInput.reference) return [];
    return sessions
      .slice()
      .sort((sessionA, sessionB) =>
        (sessionB.updated_at || sessionB.updated_time || "").localeCompare(
          sessionA.updated_at || sessionA.updated_time || ""
        )
      );
  }, [isGeneralSearch, resolvedSessionSearchInput.reference, sessions]);
  const fallbackSessionLabel = t("navigation:routes.session", "Session");
  const cloudSessionLabel = t(
    "navigation:cloud.sessionRef.chipLabel",
    "Team session"
  );
  const getSessionText = useCallback(
    (session: Session) => getSessionSearchText(session, fallbackSessionLabel),
    [fallbackSessionLabel]
  );
  const { filteredItems: matchingSessions } = useFilteredItems({
    items: sortedSessions,
    searchQuery: generalSessionSearchQuery,
    getSearchText: getSessionText,
  });

  const items = useMemo((): SpotlightItem[] => {
    const viewActions = buildViewActions(
      isSidebarCollapsed,
      isWorkStationRoute,
      isEditorRoute,
      isWorkStationRoute,
      isWorkstationSidebarCollapsed,
      isBottomPanelCollapsed,
      isChatPanelMaximized,
      isChatPanelVisible
    );
    const quickNavigationActions = isWorkStationRoute
      ? [...STATION_MODE_ACTIONS, ...QUICK_NAVIGATION_ACTIONS]
      : [];
    const chatPanelSettingsActions = buildChatPanelSettingsActions({
      chatPanelPosition,
      chatTurnPaginationEnabled,
      modelPickerStyle,
      workstationSidebarPosition,
    });

    if (stage === "confirming" || stage === "executing") {
      return [];
    }

    // ========== SEARCH MODE (Global Search) ==========
    if (searchQuery && !hasAction && !hasRepo) {
      const sessionItems = resolvedSessionSearchInput.reference
        ? [
            buildCloudSessionReferenceItem({
              reference: resolvedSessionSearchInput.reference,
              ...resolveSpotlightCloudSessionPresentation({
                reference: resolvedSessionSearchInput.reference,
                fallbackLabel: cloudSessionLabel,
                auth: cloudAuth,
                remoteEntries: cloudRemoteSessions,
                localSessions: sessions,
              }),
              onSelect: onSelectCloudSessionReference,
              idPrefix: "general-cloud-session",
            }),
          ]
        : buildSpotlightSessionItems({
            sessions: matchingSessions,
            fallbackSessionLabel,
            visitedSessions,
            query: resolvedSessionSearchInput.query,
            onSelect: onSelectSession,
            limit: GENERAL_SPOTLIGHT_SESSION_RESULT_LIMIT,
            idPrefix: "general-session",
          });

      return buildSearchModeItems({
        searchQuery,
        isEditorRoute,
        staticCommandActions: [
          ...AGENT_SESSION_ACTIONS,
          ...WORKSPACE_ACTIONS,
          ...ORGANIZATION_ACTIONS,
          ...chatPanelSettingsActions,
          ...quickNavigationActions,
          ...viewActions,
          ...APP_ACTIONS,
        ],
        onSelectAction,
        onSelectStaticAction,
        onSelectEditorAction,
        onSelectPath,
        translate,
        sessionItems,
        devModeEnabled,
      });
    }

    // ========== ACTION PATH ==========
    if (hasAction && currentAction) {
      if (currentAction.hasModal && currentAction.requiredParams.length === 0) {
        return [];
      }
      if (isComplete) {
        return [];
      }
      if (missingParam === "repo") {
        return sortRepoItemsSelectedFirst(
          buildRepoSpotlightItems(filteredRepos, {
            currentRepoId,
            onAction: onSelectRepo,
            idPrefix: "repo-",
          })
        );
      }
      if (missingParam === "branch") {
        return buildBranchSpotlightItems(filteredBranches, {
          onAction: onSelectBranch,
        });
      }
      if (missingParam === "language") {
        return buildLanguageItems(
          currentLanguage,
          searchQuery,
          onSelectLanguage,
          translate
        );
      }
      if (missingParam === "theme") {
        return buildThemeItems(
          globalThemeId,
          systemColorScheme,
          searchQuery,
          onSelectTheme,
          translate
        );
      }
      if (missingParam === "skin") {
        return buildSkinItems(
          activeSkinId,
          skinVariant,
          searchQuery,
          onSelectSkin,
          translate
        );
      }
      return [];
    }

    // ========== REPO-FIRST PATH ==========
    if (hasRepo && !hasAction) {
      return buildRepoActionItems(onSelectAction, translate);
    }

    // ========== DEFAULT GROUPED SECTIONS ==========
    const agentSessionItems = buildStaticActionItems(
      AGENT_SESSION_ACTIONS,
      onSelectStaticAction,
      translate
    );
    const workspaceItems = [
      ...buildStaticActionItems(
        WORKSPACE_ACTIONS,
        onSelectStaticAction,
        translate
      ),
      ...buildStaticActionItems(
        ORGANIZATION_ACTIONS,
        onSelectStaticAction,
        translate
      ),
      ...buildActionItems(onSelectAction, translate),
    ];
    const quickNavigationItems = buildStaticActionItems(
      quickNavigationActions,
      onSelectStaticAction,
      translate
    );
    const editorItems = isEditorRoute
      ? buildEditorActionItems(onSelectEditorAction, translate)
      : [];
    const viewItems = buildStaticActionItems(
      [...chatPanelSettingsActions, ...viewActions, ...APP_ACTIONS],
      onSelectStaticAction,
      translate
    );
    const navActionItems = NAV_DESTINATIONS.filter(
      (destination) =>
        destination.group === "actions" &&
        (devModeEnabled || !destination.devOnly)
    ).map((destination) =>
      buildNavDestinationItem(destination, onSelectPath, translate)
    );

    // Recently used: resolve persisted ids back to whichever static command
    // definitions are currently available (state-dependent chat-panel actions
    // only exist when applicable). Unknown ids are dropped so stale entries
    // never render.
    const recentItems = buildStaticActionItems(
      resolveRecentDefinitions(recentActionIds, [
        ...AGENT_SESSION_ACTIONS,
        ...WORKSPACE_ACTIONS,
        ...ORGANIZATION_ACTIONS,
        ...chatPanelSettingsActions,
        ...quickNavigationActions,
        ...viewActions,
        ...APP_ACTIONS,
      ]),
      onSelectStaticAction,
      translate
    );

    return buildGroupedDefaultItems(
      recentItems,
      agentSessionItems,
      workspaceItems,
      quickNavigationItems,
      editorItems,
      viewItems,
      navActionItems,
      translate
    );
  }, [
    stage,
    currentAction,
    missingParam,
    searchQuery,
    isComplete,
    hasAction,
    hasRepo,
    isSidebarCollapsed,
    isWorkstationSidebarCollapsed,
    isBottomPanelCollapsed,
    isChatPanelMaximized,
    isChatPanelVisible,
    globalThemeId,
    systemColorScheme,
    activeSkinId,
    skinVariant,
    chatPanelPosition,
    chatTurnPaginationEnabled,
    modelPickerStyle,
    workstationSidebarPosition,
    currentLanguage,
    recentActionIds,
    matchingSessions,
    fallbackSessionLabel,
    cloudSessionLabel,
    cloudAuth,
    cloudRemoteSessions,
    sessions,
    visitedSessions,
    resolvedSessionSearchInput,
    devModeEnabled,
    isEditorRoute,
    isWorkStationRoute,
    filteredRepos,
    filteredBranches,
    currentRepoId,
    onSelectAction,
    onSelectStaticAction,
    onSelectEditorAction,
    onSelectRepo,
    onSelectBranch,
    onSelectLanguage,
    onSelectTheme,
    onSelectSkin,
    onSelectSession,
    onSelectCloudSessionReference,
    onSelectPath,
    translate,
  ]);

  return {
    items,
    isLoading: false,
  };
}
