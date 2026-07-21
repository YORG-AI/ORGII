/**
 * SettingsSidebar
 *
 * Sidebar for the Settings page. The first level shows app settings plus
 * integration categories. Agent Teams now opens a single table surface; its
 * Agents / Teams / CLIs switcher lives inside the page, not in a drill-down
 * sidebar level.
 */
import { useAtomValue, useSetAtom } from "jotai";
import {
  Infinity as InfinityIcon,
  ChevronLeft,
  Search,
  Settings,
} from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import {
  type CoreSettingsItemSegment,
  type IntegrationsCategorySegment,
  buildAgentOrgsPath,
  buildCoreSettingsItemPath,
  buildIntegrationsPath,
  getSegmentIcon,
  parseCoreSettingsItem,
  parseSettingsTopTab,
} from "@src/config/mainAppPaths";
import { ROUTES } from "@src/config/routes";
import { SIDEBAR_MEMORY_KIND, useSidebarMemoryEntry } from "@src/hooks/perf";
import { APP_SECTIONS } from "@src/modules/MainApp/Settings/config";
import { devModeEnabledAtom } from "@src/store/platform/devModeAtom";
import { spotlightOpenAtom } from "@src/store/ui/uiAtom";
import { settingsReturnRouteAtom } from "@src/store/ui/viewModeAtom";

import SidebarBase from "../SidebarBase";
import {
  SidebarBottomBar,
  SidebarHeaderNavButton,
  SidebarList,
} from "../blocks";
import HoverAnimatedIcon, {
  triggerIconAnimation,
} from "../components/HoverAnimatedIcon";
import NavigationMenu from "../components/NavigationMenu";
import type { NavigationMenuItem } from "../components/NavigationMenu/config";
import { SidebarRamMonitorButton } from "../connectors/SidebarRamMonitorButton";
import { SidebarSearchShortcutTooltip } from "../connectors/WorkstationSidebarConnector/sidebarTabs";

interface SettingsRootSectionConfig {
  id: string;
  labelKey: string;
  itemIds: readonly SettingsRootItemSegment[];
}

type SettingsRootItemSegment =
  | IntegrationsCategorySegment
  | typeof AGENT_ORG_ROW_KEY
  | typeof SECURITY_ITEM_KEY;

const AGENT_ORG_ROW_KEY = "agent-orgs";
/**
 * Security is a core-settings section (renders like General/Appearance) but
 * lives in the Core sidebar group rather than the top app-sections list.
 */
const SECURITY_ITEM_KEY = "security";
const AGENT_ORG_PATH = buildAgentOrgsPath({ tab: "agents" });

interface SettingsFooterBackButtonProps {
  label: string;
  onClick: () => void;
}

const SettingsFooterBackButton: React.FC<SettingsFooterBackButtonProps> = ({
  label,
  onClick,
}) => (
  <button
    type="button"
    aria-label={label}
    className="flex h-[28px] w-[28px] cursor-pointer items-center justify-center rounded-[100px] border-none bg-sidebar-selected p-0 text-text-1 transition-colors duration-150 hover:bg-sidebar-selected"
    onClick={onClick}
    onMouseEnter={(event) => triggerIconAnimation(event.currentTarget)}
  >
    <HoverAnimatedIcon
      icon={Settings}
      iconName="settings"
      size={16}
      strokeWidth={2}
      className="text-text-1"
    />
  </button>
);

function isAgentOrgsRoute(pathname: string): boolean {
  const topTab = parseSettingsTopTab(pathname);
  return topTab === "agent-orgs";
}

const SETTINGS_ROOT_INTEGRATION_KEYS: readonly IntegrationsCategorySegment[] = [
  "models",
  "myRoles",
  "rulesMemoryEvolution",
  "routines",
  "tools",
  "computerUse",
  "externalSkillsets",
  "devtools",
  "connections",
  "git",
  "databases",
  "housekeeper",
];

const SETTINGS_ROOT_LIST_SECTIONS: SettingsRootSectionConfig[] = [
  {
    id: "core",
    labelKey: "coreSidebar.groups.core",
    itemIds: [
      AGENT_ORG_ROW_KEY,
      "models",
      "myRoles",
      "rulesMemoryEvolution",
      SECURITY_ITEM_KEY,
      "routines",
    ],
  },
  {
    id: "tools",
    labelKey: "coreSidebar.groups.tools",
    itemIds: ["tools", "computerUse", "externalSkillsets", "devtools"],
  },
  {
    id: "connections",
    labelKey: "coreSidebar.groups.connections",
    itemIds: ["connections", "git", "databases", "housekeeper"],
  },
];

const SettingsSidebar: React.FC = () => {
  const { t } = useTranslation("navigation");
  const navigate = useNavigate();
  const settingsReturnRoute = useAtomValue(settingsReturnRouteAtom);
  const devModeEnabled = useAtomValue(devModeEnabledAtom);
  const setSpotlightOpen = useSetAtom(spotlightOpenAtom);

  const handleBack = useCallback(() => {
    navigate(settingsReturnRoute || ROUTES.app.home.start.path);
  }, [navigate, settingsReturnRoute]);

  const handleOpenSpotlight = useCallback(() => {
    setSpotlightOpen(true);
  }, [setSpotlightOpen]);

  const settingsReturnItem = useMemo(
    () => (
      <SidebarHeaderNavButton
        icon={ChevronLeft}
        label={t("labels.settings")}
        onClick={handleBack}
      />
    ),
    [handleBack, t]
  );

  return (
    <SidebarBase
      onAddNew={handleOpenSpotlight}
      addIcon={Search}
      addLabel={t("common:actions.search")}
      addTooltipContent={
        <SidebarSearchShortcutTooltip
          searchLabel={t("common:actions.search")}
        />
      }
    >
      <div className="shrink-0 px-3">{settingsReturnItem}</div>
      <SettingsRootBody />
      <SidebarBottomBar
        rightActions={
          <>
            {devModeEnabled && <SidebarRamMonitorButton />}
            <SettingsFooterBackButton
              label={t("sidebar.bottomBar.settings")}
              onClick={handleBack}
            />
          </>
        }
      />
    </SidebarBase>
  );
};

export default SettingsSidebar;

const SettingsRootBody: React.FC = () => {
  const { t } = useTranslation("settings");
  const navigate = useNavigate();
  const location = useLocation();

  const activeItemId: string = useMemo(() => {
    const topTab = parseSettingsTopTab(location.pathname);
    const fallback = APP_SECTIONS[0].id;
    if (isAgentOrgsRoute(location.pathname)) return AGENT_ORG_ROW_KEY;
    if (topTab === "integrations") {
      const { category } = parseCoreSettingsItem(location.pathname);
      return category ?? fallback;
    }
    if (topTab !== "core-settings") return fallback;
    const { section, category } = parseCoreSettingsItem(location.pathname);
    return section ?? category ?? fallback;
  }, [location.pathname]);

  const appSectionItems = useMemo<NavigationMenuItem[]>(
    () =>
      APP_SECTIONS
        // Security renders in the Core group below, not the top app list.
        .filter((section) => section.id !== SECURITY_ITEM_KEY)
        .map((section) => ({
          id: section.id,
          key: section.id,
          label: t(`settings:sections.${section.labelKey}`),
          icon: section.icon,
          dataTestId: `settings-core-item-${section.id}`,
        })),
    [t]
  );

  const integrationsSections = useMemo(
    () =>
      SETTINGS_ROOT_LIST_SECTIONS.map((section) => ({
        id: section.id,
        title: t(`settings:${section.labelKey}`),
        items: section.itemIds.map<NavigationMenuItem>((id) => {
          if (id === AGENT_ORG_ROW_KEY) {
            return {
              id,
              key: id,
              label: t("navigation:labels.agentOrgs"),
              icon: InfinityIcon,
              dataTestId: "settings-core-item-agent-orgs",
            };
          }
          const icon = getSegmentIcon(id);
          if (!icon) {
            throw new Error(
              `SettingsSidebar: missing segment-registry entry for "${id}"`
            );
          }
          return {
            id,
            key: id,
            label: t(`settings:coreSidebar.items.${id}`),
            icon,
            dataTestId: `settings-core-item-${id}`,
          };
        }),
      })),
    [t]
  );

  const handleItemClick = useCallback(
    (key: string) => {
      if (key === AGENT_ORG_ROW_KEY) {
        navigate(AGENT_ORG_PATH);
        return;
      }
      if ((SETTINGS_ROOT_INTEGRATION_KEYS as readonly string[]).includes(key)) {
        navigate(
          buildIntegrationsPath({
            category: key as IntegrationsCategorySegment,
          })
        );
        return;
      }
      navigate(buildCoreSettingsItemPath(key as CoreSettingsItemSegment));
    },
    [navigate]
  );

  const selectedKeys = useMemo(() => [activeItemId], [activeItemId]);
  const integrationItemCount = integrationsSections.reduce(
    (sum, section) => sum + section.items.length,
    0
  );

  useSidebarMemoryEntry({
    kind: SIDEBAR_MEMORY_KIND.SETTINGS,
    label: "Settings root",
    items: appSectionItems.length + integrationItemCount,
    sections: integrationsSections.length + 1,
    source: { activeItemId, appSectionItems, integrationsSections },
  });

  return (
    <SidebarList className="pt-1">
      <NavigationMenu
        items={appSectionItems}
        selectedKeys={selectedKeys}
        onMenuItemClick={handleItemClick}
      />
      {integrationsSections.map((section) => (
        <div key={section.id} className="mt-4">
          <div className="mb-2 px-2 text-[11px] font-medium uppercase tracking-wider text-text-1">
            {section.title}
          </div>
          <NavigationMenu
            items={section.items}
            selectedKeys={selectedKeys}
            onMenuItemClick={handleItemClick}
          />
        </div>
      ))}
    </SidebarList>
  );
};
