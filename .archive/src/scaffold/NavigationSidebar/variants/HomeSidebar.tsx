/**
 * HomeSidebar
 *
 * Home navigation sidebar with an Open Workstation header action.
 * Swaps to second-level sidebars when on focused app pages.
 *
 * Tab Behavior: Uses "reuse" mode - clicking sidebar items updates the
 * existing main tab instead of creating new tabs.
 */
import { MenuItem, Menu as TauriMenu } from "@tauri-apps/api/menu";
import i18next from "i18next";
import { useSetAtom } from "jotai";
import {
  ArrowUpRight,
  ChartNoAxesGantt,
  FolderGit2,
  Search,
  SquareMousePointer,
} from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { ROUTES } from "@src/config/routes";
import { useRouteLabel } from "@src/hooks/i18n";
import { SIDEBAR_MEMORY_KIND, useSidebarMemoryEntry } from "@src/hooks/perf";
import { spotlightOpenAtom } from "@src/store/ui/uiAtom";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import { SidebarBottomBar } from "../blocks";
import SidebarSettingsMenuButton from "../blocks/SidebarSettingsMenuButton";
import type { NavigationMenuItem } from "../components/NavigationMenu/config";
import { SidebarSearchShortcutTooltip } from "../connectors/WorkstationSidebarConnector/sidebarTabs";
import type { SidebarTab } from "../types";
import { routeToMenuItem } from "../utils/menuFromRoutes";
import NavigationSidebar from "./NavigationSidebar";
import SettingsSidebar from "./SettingsSidebar";

// ============================================
// Helpers
// ============================================

const HOME_SIDEBAR_TABS: SidebarTab[] = [];
const noopSidebarTabChange = () => undefined;

const ORGII_GITHUB_URL = "https://github.com/YORG-AI/ORGII";
const GITHUB_MENU_ITEM_KEY = "external-github";

// ============================================
// Component
// ============================================

const HomeSidebar: React.FC = () => {
  const { t } = useTranslation("navigation");
  const { getTranslatedRouteLabel } = useRouteLabel();
  const navigate = useNavigate();
  const location = useLocation();
  const setSpotlightOpen = useSetAtom(spotlightOpenAtom);

  // Unified settings surface covers all /settings namespaces;
  // SettingsSidebar owns the nested settings levels.
  const isOnSettings = location.pathname.startsWith(ROUTES.app.settings.path);

  // Build menu items — labels from route config via useRouteLabel (same as PageBreadcrumb)
  const buildMenuItems = useMemo(
    (): NavigationMenuItem[] => [
      {
        id: ROUTES.workStation.base.path,
        key: ROUTES.workStation.base.path,
        label: t("sidebar.tabs.workstation"),
        icon: SquareMousePointer,
        iconName: "square-mouse-pointer",
        routePath: ROUTES.workStation.base.path,
      },
      routeToMenuItem(ROUTES.app.home.start, {
        label: getTranslatedRouteLabel(ROUTES.app.home.start),
      }),
      {
        id: GITHUB_MENU_ITEM_KEY,
        key: GITHUB_MENU_ITEM_KEY,
        label: t("sidebar.groups.openSource"),
        icon: FolderGit2,
        iconName: "folder-git-2",
        trailingElement: <ArrowUpRight size={13} strokeWidth={2} />,
      },
      routeToMenuItem(ROUTES.app.home.changelog, {
        label: t("routes.changelog"),
        icon: ChartNoAxesGantt,
        iconName: "chart-no-axes-gantt",
      }),
    ],
    [t, getTranslatedRouteLabel]
  );

  // Compute selected key - handle nested routes
  const selectedKey = useMemo(() => {
    const pathname = location.pathname;
    const allPaths = [ROUTES.app.home.changelog.path];
    for (const path of allPaths) {
      if (pathname.startsWith(path)) {
        return path;
      }
    }
    return pathname;
  }, [location.pathname]);

  useSidebarMemoryEntry({
    kind: SIDEBAR_MEMORY_KIND.START_PAGE,
    label: "Start page",
    items: buildMenuItems.length,
    source: { buildMenuItems, selectedKey },
    enabled: !isOnSettings,
  });

  const handleOpenWorkstation = useCallback(() => {
    navigate(ROUTES.workStation.base.path, { replace: false });
  }, [navigate]);

  const handleOpenSpotlight = useCallback(() => {
    setSpotlightOpen(true);
  }, [setSpotlightOpen]);

  const workstationHeaderAction = useMemo(
    () => (
      <Tooltip
        content={
          <KeyboardShortcutTooltipContent
            label={t("sidebar.actions.openWorkstation")}
          />
        }
        position="bottom"
        mouseEnterDelay={200}
        framedPanel
      >
        <div className="inline-flex">
          <button
            type="button"
            className="flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[100px] border-none bg-transparent p-0 transition-colors duration-150 hover:bg-sidebar-selected"
            onClick={handleOpenWorkstation}
          >
            <SquareMousePointer
              size={16}
              strokeWidth={2}
              className="text-text-2"
            />
          </button>
        </div>
      </Tooltip>
    ),
    [handleOpenWorkstation, t]
  );

  const handleMenuItemClick = useCallback(
    (key: string, item: NavigationMenuItem) => {
      if (key === GITHUB_MENU_ITEM_KEY) {
        void openExternalLink(ORGII_GITHUB_URL);
        return;
      }

      if (item.routePath) {
        navigate(item.routePath, { replace: false });
      }
    },
    [navigate]
  );

  const handleMenuItemContextMenu = useCallback(
    async (e: React.MouseEvent, key: string, item: NavigationMenuItem) => {
      e.preventDefault();
      e.stopPropagation();
      if (!item.routePath && key !== GITHUB_MENU_ITEM_KEY) return;

      const t = i18next.t.bind(i18next);

      const openItem = await MenuItem.new({
        text: t("actions.open"),
        action: () => {
          if (key === GITHUB_MENU_ITEM_KEY) {
            void openExternalLink(ORGII_GITHUB_URL);
            return;
          }

          if (!item.routePath) return;
          navigate(item.routePath, { replace: false });
        },
      });

      const menu = await TauriMenu.new({
        items: [openItem],
      });

      await menu.popup();
    },
    [navigate]
  );

  if (isOnSettings) {
    return <SettingsSidebar />;
  }

  return (
    <NavigationSidebar
      items={HOME_SIDEBAR_TABS}
      activeKey="build"
      onChange={noopSidebarTabChange}
      menuItems={buildMenuItems}
      selectedKey={selectedKey}
      onMenuItemClick={handleMenuItemClick}
      onMenuItemContextMenu={handleMenuItemContextMenu}
      onAddNew={handleOpenSpotlight}
      addIcon={Search}
      addLabel={t("common:actions.search")}
      addTooltipContent={
        <SidebarSearchShortcutTooltip
          searchLabel={t("common:actions.search")}
        />
      }
      beforeAddNewActions={workstationHeaderAction}
      defaultOpenKeys={["workspace"]}
      enableHoverIconAnimation
      bottomContent={
        <SidebarBottomBar settingsAction={<SidebarSettingsMenuButton />} />
      }
    />
  );
};

export default HomeSidebar;
