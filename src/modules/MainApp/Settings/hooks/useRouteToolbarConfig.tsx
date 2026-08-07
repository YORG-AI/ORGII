/**
 * useRouteToolbarConfig Hook
 *
 * Derives per-route header action configuration synchronously from:
 * - Current pathname (via useLocation)
 * - Integrations category atom (for per-tab + button behavior)
 * - Integrations add action atom (callback to dispatch add actions)
 */
import { useAtomValue, useSetAtom } from "jotai";
import {
  Check,
  Folder,
  Network,
  Pencil,
  RefreshCw,
  UserPlus,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import {
  type AddAction,
  CATEGORY_KEYS,
  type IntegrationCategory,
} from "@src/api/types/integrations";
import {
  WIZARD_IDS,
  buildAgentOrgsPath,
  buildWizardPath,
  parseCoreSettingsItem,
  parseSettingsTopTab,
} from "@src/config/mainAppPaths";
import { ROUTE_PATHS } from "@src/config/routePaths";
import { ROUTES } from "@src/config/routes";
import { useRefreshSpin } from "@src/hooks/ui/useRefreshSpin";
import { appGridEditModeAtom } from "@src/store/ui/appGridAtom";
import {
  dispatchIntegrationsAddAtom,
  integrationsToolbarAtom,
} from "@src/store/ui/integrationsToolbarAtom";
import {
  addWorkspaceInitialStageAtom,
  repoSelectorOpenAtom,
} from "@src/store/ui/overlayAtom";
import type {
  RouteToolbarButton,
  RouteToolbarConfig,
} from "@src/store/ui/routeToolbarAtom";
import { settingsToolbarAtom } from "@src/store/ui/settingsToolbarAtom";

import { getPlusConfigForCategory } from "./toolbarPlusConfigs";
import { useSettingsRegionNoticeButton } from "./useSettingsRegionNoticeButton";

function toIntegrationCategory(
  category: string | null | undefined
): IntegrationCategory {
  if (category && (CATEGORY_KEYS as readonly string[]).includes(category)) {
    return category as IntegrationCategory;
  }
  return "models";
}

const SETTINGS_PREFIX = ROUTES.app.settings.path;

export function useRouteToolbarConfig(): RouteToolbarConfig | null {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { t } = useTranslation("integrations");

  const noop = useMemo(() => () => {}, []);

  const settingsToolbar = useAtomValue(settingsToolbarAtom);
  const settingsRegionNoticeButton = useSettingsRegionNoticeButton();
  const { spinClass: settingsSpinClass, handleClick: settingsRefreshClick } =
    useRefreshSpin(
      settingsToolbar.onRefresh ?? noop,
      settingsToolbar.loading ?? false
    );

  const appGridEditMode = useAtomValue(appGridEditModeAtom);
  const setAppGridEditMode = useSetAtom(appGridEditModeAtom);
  const setRepoSelectorOpen = useSetAtom(repoSelectorOpenAtom);
  const setAddWorkspaceInitialStage = useSetAtom(addWorkspaceInitialStageAtom);

  const openAddWorkspace = useCallback(() => {
    setAddWorkspaceInitialStage("add-workspace-existing");
    setRepoSelectorOpen(true);
  }, [setAddWorkspaceInitialStage, setRepoSelectorOpen]);

  const toggleAppGridEditing = useCallback(() => {
    setAppGridEditMode((current) => !current);
  }, [setAppGridEditMode]);

  const openAgentAdd = useCallback(() => {
    const agentsPath = buildAgentOrgsPath({ tab: "agents" });
    navigate(buildWizardPath(agentsPath, WIZARD_IDS.AGENT_ADD));
  }, [navigate]);

  const openOrgAdd = useCallback(() => {
    const agentsPath = buildAgentOrgsPath({ tab: "agents" });
    navigate(buildWizardPath(agentsPath, WIZARD_IDS.ORG_ADD));
  }, [navigate]);

  const coreSettingsItem = useMemo(
    () => parseCoreSettingsItem(pathname),
    [pathname]
  );
  const integrationCategory = toIntegrationCategory(coreSettingsItem.category);
  const dispatchAddAction = useSetAtom(dispatchIntegrationsAddAtom);
  const integrationsToolbar = useAtomValue(integrationsToolbarAtom);
  const {
    spinClass: integrationsSpinClass,
    handleClick: integrationsRefreshClick,
  } = useRefreshSpin(
    integrationsToolbar.onRefresh ?? noop,
    integrationsToolbar.loading ?? false
  );

  return useMemo(() => {
    if (pathname.startsWith(SETTINGS_PREFIX)) {
      const topTab = parseSettingsTopTab(pathname);

      if (topTab === "agent-orgs") {
        return {
          extraButtons: settingsRegionNoticeButton
            ? [settingsRegionNoticeButton]
            : undefined,
          plusDropdownItems: [
            {
              id: "add-agent",
              label: t("toolbarPlusMenu.addAgent"),
              icon: UserPlus,
              onClick: openAgentAdd,
            },
            {
              id: "add-org",
              label: t("agentOrgs.addOrg"),
              icon: Network,
              onClick: openOrgAdd,
            },
          ],
        };
      }

      if (coreSettingsItem.category) {
        const dispatch = (action: AddAction) => dispatchAddAction(action);

        const plusConfig = getPlusConfigForCategory(
          integrationCategory,
          dispatch,
          t
        );

        const extraButtons: RouteToolbarButton[] = [];

        if (settingsRegionNoticeButton) {
          extraButtons.push(settingsRegionNoticeButton);
        }

        if (integrationsToolbar.onRefresh) {
          extraButtons.push({
            id: "integrations-refresh",
            icon: RefreshCw,
            onClick: integrationsRefreshClick,
            title: t("common:actions.refresh"),
            iconClassName: integrationsSpinClass,
            disabled: !!integrationsSpinClass,
          });
        }

        extraButtons.push(...(integrationsToolbar.extraButtons ?? []));

        return {
          ...plusConfig,
          extraButtons: extraButtons.length > 0 ? extraButtons : undefined,
        };
      }

      const extraButtons: RouteToolbarButton[] = [];

      if (settingsRegionNoticeButton) {
        extraButtons.push(settingsRegionNoticeButton);
      }

      extraButtons.push(...(settingsToolbar.extraButtons ?? []));

      if (settingsToolbar.onRefresh) {
        extraButtons.push({
          id: "settings-refresh",
          icon: RefreshCw,
          onClick: settingsRefreshClick,
          title: t("common:actions.refresh"),
          iconClassName: settingsSpinClass,
          disabled: !!settingsSpinClass,
        });
      }

      return {
        extraButtons: extraButtons.length > 0 ? extraButtons : undefined,
      };
    }

    if (pathname.startsWith(ROUTE_PATHS.startPage)) {
      return {
        ellipsisItems: [
          {
            id: "customize-grid",
            label: appGridEditMode
              ? t("common:actions.done")
              : t("navigation:appGrid.customizeGrid"),
            icon: appGridEditMode ? Check : Pencil,
            onClick: toggleAppGridEditing,
          },
        ],
        plusDropdownItems: [
          {
            id: "add-workspace",
            label: t("common:actions.addWorkspace"),
            icon: Folder,
            onClick: openAddWorkspace,
          },
        ],
      };
    }

    return null;
  }, [
    pathname,
    settingsToolbar,
    settingsRegionNoticeButton,
    settingsRefreshClick,
    settingsSpinClass,
    openAgentAdd,
    openOrgAdd,
    coreSettingsItem,
    integrationCategory,
    dispatchAddAction,
    integrationsToolbar,
    integrationsRefreshClick,
    integrationsSpinClass,
    appGridEditMode,
    openAddWorkspace,
    toggleAppGridEditing,
    t,
  ]);
}
