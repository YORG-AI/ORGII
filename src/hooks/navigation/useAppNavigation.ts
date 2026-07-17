/**
 * useAppNavigation Hook
 *
 * Unified navigation system for cross-view-mode navigation.
 * Route is the single source of truth - all navigation goes through React Router.
 *
 * Features:
 * - Clean view mode switching (mainApp ↔ session ↔ code)
 * - MainApp tab management integrated with navigation
 * - WorkStation app mode navigation (code, database, browser)
 * - Session route navigation
 *
 * Usage:
 * ```tsx
 * const { navigateTo, goToSettings, goToEditor, goToNewSession } = useAppNavigation();
 *
 * // Navigate to specific mainApp route with tab
 * goToSettings();
 *
 * // Navigate to WorkStation with specific app
 * goToEditor(); // or goToBrowser()
 *
 * // Navigate to session creator (clears active session)
 * goToNewSession(); // or goToNewSession({ projectId, workflowId })
 * ```
 *
 * Architecture:
 * - Uses React Router's navigate() for all navigation
 * - MainApp tabs are created/activated via atoms (no navigation in tab atoms)
 * - ViewModeSync handles viewMode atom updates based on route changes
 *
 * Created: 2026-02-01
 */
import { useSetAtom } from "jotai";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import {
  type ExternalSkillsetsTab,
  type IntegrationsCategorySegment,
  buildExternalSkillsetsPath,
  buildIntegrationsPath,
} from "@src/config/mainAppPaths";
import { ROUTES } from "@src/config/routes";
import { clearSessionAtom } from "@src/engines/SessionCore/core/atoms";
import { preloadRouteByPath } from "@src/router/lazy/preload";
import {
  activeSessionIdAtom,
  promoteActiveSessionCreatorDraftAtom,
  selectSessionCreatorDraftAtom,
  startNewSessionCreatorDraftAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import {
  CHAT_PANEL_SURFACE_KIND,
  chatPanelNavigateAtom,
} from "@src/store/ui/chatPanelAtom";

// ============================================
// Types
// ============================================

/** Workstation app modes */
export type WorkStationApp = "code" | "browser";

/** Navigation options */
export interface NavigateOptions {
  /** Replace current history entry instead of pushing */
  replace?: boolean;
  /** Navigation state to pass to the route */
  state?: Record<string, unknown>;
}

/** Tab configuration for mainApp navigation */
export interface MainAppTabConfig {
  title: string;
  icon?: string;
}

/** Optional query params when opening the empty session workspace */
export interface GoToNewSessionOptions {
  projectId?: string;
  workflowId?: string;
  draftId?: string;
  preserveActiveDraft?: boolean;
}

// ============================================
// Route Mappings
// ============================================

const WORK_STATION_ROUTES: Record<WorkStationApp, string> = {
  code: ROUTES.workStation.code.path,
  browser: ROUTES.workStation.browser.path,
};

// ============================================
// Hook Implementation
// ============================================

export interface UseAppNavigationReturn {
  // Generic navigation
  navigateTo: (path: string, options?: NavigateOptions) => void;

  // MainApp navigation (creates/activates tabs)
  navigateToMainApp: (
    path: string,
    tabConfig: MainAppTabConfig,
    options?: NavigateOptions
  ) => void;

  // Workstation navigation
  navigateToWorkStation: (
    app?: WorkStationApp,
    options?: NavigateOptions
  ) => void;

  // Convenience methods
  goToStartPage: () => void;
  goToSettings: () => void;
  goToProjects: () => void;
  goToMarket: () => void;
  goToIntegrations: (options?: {
    category?: IntegrationsCategorySegment;
    modelsTab?: string;
    devToolsTab?: string;
    skillsetTab?: ExternalSkillsetsTab;
  }) => void;
  goToAgentOrgs: () => void;
  goToEditor: () => void;
  goToBrowser: () => void;
  goToNewSession: (options?: GoToNewSessionOptions) => void;
}

export function useAppNavigation(): UseAppNavigationReturn {
  const navigate = useNavigate();
  const { t: tNav } = useTranslation("navigation");

  // Session lifecycle atoms (for goToNewSession)
  const dispatchClearSession = useSetAtom(clearSessionAtom);
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const setWorkstationActiveSessionId = useSetAtom(
    workstationActiveSessionIdAtom
  );
  const navigateChatPanel = useSetAtom(chatPanelNavigateAtom);
  const startNewSessionCreatorDraft = useSetAtom(
    startNewSessionCreatorDraftAtom
  );
  const selectSessionCreatorDraft = useSetAtom(selectSessionCreatorDraftAtom);
  const promoteActiveSessionCreatorDraft = useSetAtom(
    promoteActiveSessionCreatorDraftAtom
  );

  // ========================================
  // Core Navigation Functions
  // ========================================

  /**
   * Generic navigation - just navigates, no tab management
   */
  const navigateTo = useCallback(
    (path: string, options?: NavigateOptions) => {
      promoteActiveSessionCreatorDraft();
      preloadRouteByPath(path);
      navigate(path, {
        replace: options?.replace,
        state: options?.state,
      });
    },
    [navigate, promoteActiveSessionCreatorDraft]
  );

  const navigateToMainApp = useCallback(
    (path: string, _tabConfig: MainAppTabConfig, options?: NavigateOptions) => {
      promoteActiveSessionCreatorDraft();
      navigate(path, {
        replace: options?.replace,
        state: options?.state,
      });
    },
    [navigate, promoteActiveSessionCreatorDraft]
  );

  /**
   * Workstation navigation
   * Navigates to the specified app (code, database, browser)
   */
  const navigateToWorkStation = useCallback(
    (app: WorkStationApp = "code", options?: NavigateOptions) => {
      promoteActiveSessionCreatorDraft();
      const path = WORK_STATION_ROUTES[app];
      navigate(path, {
        replace: options?.replace,
        state: options?.state,
      });
    },
    [navigate, promoteActiveSessionCreatorDraft]
  );

  // ========================================
  // Convenience Methods
  // ========================================

  const goToStartPage = useCallback(() => {
    navigateToMainApp(ROUTES.app.home.start.path, {
      title: "Start Page",
      icon: "home",
    });
  }, [navigateToMainApp]);

  const goToSettings = useCallback(() => {
    navigateToMainApp(ROUTES.app.settings.path, {
      title: "Settings",
      icon: "settings",
    });
  }, [navigateToMainApp]);

  const goToProjects = useCallback(() => {
    promoteActiveSessionCreatorDraft();
    navigate(ROUTES.workStation.project.path);
  }, [navigate, promoteActiveSessionCreatorDraft]);

  const goToMarket = useCallback(() => {
    navigateToMainApp(ROUTES.app.market.tokenMarket.path, {
      title: "Token Market",
      icon: "store",
    });
  }, [navigateToMainApp]);

  const goToIntegrations = useCallback(
    (options?: {
      category?: IntegrationsCategorySegment;
      modelsTab?: string;
      devToolsTab?: string;
      skillsetTab?: ExternalSkillsetsTab;
    }) => {
      const category = options?.category ?? "externalSkillsets";

      if (category === "externalSkillsets") {
        const built = buildExternalSkillsetsPath({ tab: options?.skillsetTab });
        const [pathname, existingSearch = ""] = built.split("?");
        const search = new URLSearchParams(existingSearch);
        if (options?.modelsTab) search.set("modelsTab", options.modelsTab);
        if (options?.devToolsTab) {
          search.set("devToolsTab", options.devToolsTab);
        }
        const query = search.toString();
        navigateToMainApp(query ? `${pathname}?${query}` : pathname, {
          title: tNav("labels.agentOrgs"),
          icon: "infinity",
        });
        return;
      }

      const basePath = buildIntegrationsPath({ category });
      const search = new URLSearchParams();
      if (options?.modelsTab) search.set("modelsTab", options.modelsTab);
      if (options?.devToolsTab) search.set("devToolsTab", options.devToolsTab);
      const query = search.toString();
      const path = query ? `${basePath}?${query}` : basePath;
      navigateToMainApp(path, {
        title: tNav("labels.agentOrgs"),
        icon: "infinity",
      });
    },
    [navigateToMainApp, tNav]
  );

  const goToAgentOrgs = useCallback(() => {
    navigateToMainApp(ROUTES.app.home.agentOrgs.path, {
      title: tNav("labels.agentOrgs"),
      icon: "infinity",
    });
  }, [navigateToMainApp, tNav]);

  const goToEditor = useCallback(() => {
    navigateToWorkStation("code");
  }, [navigateToWorkStation]);

  const goToBrowser = useCallback(() => {
    navigateToWorkStation("browser");
  }, [navigateToWorkStation]);

  const goToNewSession = useCallback(
    (options?: GoToNewSessionOptions) => {
      dispatchClearSession();
      navigateChatPanel({ kind: CHAT_PANEL_SURFACE_KIND.SESSION });
      // Starting a session changes chat identity, not the WorkStation layout.
      setActiveSessionId(null);
      setWorkstationActiveSessionId(null);

      if (!options?.preserveActiveDraft) {
        promoteActiveSessionCreatorDraft();
      }

      if (options?.draftId) {
        selectSessionCreatorDraft(options.draftId);
      } else if (!options?.preserveActiveDraft) {
        startNewSessionCreatorDraft();
      }

      const params = new URLSearchParams();
      if (options?.projectId) {
        params.set("projectId", options.projectId);
      }
      if (options?.workflowId) {
        params.set("workflowId", options.workflowId);
      }
      const query = params.toString();
      const path = query
        ? `${ROUTES.workStation.code.path}?${query}`
        : ROUTES.workStation.code.path;
      navigate(path);
    },
    [
      dispatchClearSession,
      navigateChatPanel,
      setActiveSessionId,
      setWorkstationActiveSessionId,
      promoteActiveSessionCreatorDraft,
      selectSessionCreatorDraft,
      startNewSessionCreatorDraft,
      navigate,
    ]
  );

  // ========================================
  // Return
  // ========================================

  return {
    // Core navigation
    navigateTo,
    navigateToMainApp,
    navigateToWorkStation,

    // Convenience methods
    goToStartPage,
    goToSettings,
    goToProjects,
    goToMarket,
    goToIntegrations,
    goToAgentOrgs,
    goToEditor,
    goToBrowser,
    goToNewSession,
  };
}

export default useAppNavigation;
