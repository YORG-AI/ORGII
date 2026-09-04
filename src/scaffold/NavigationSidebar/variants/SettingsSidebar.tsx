/**
 * SettingsSidebar
 *
 * Sidebar for the Settings page. The first level shows app settings plus
 * integration categories. Agent Teams now opens a single table surface; its
 * Agents / Teams / CLIs switcher lives inside the page, not in a drill-down
 * sidebar level.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import {
  type SettingsNavigationGroup,
  type SettingsNavigationItem,
  type SettingsNavigationItemId,
  buildSettingsNavigationGroups,
  getActiveSettingsNavigationItemId,
} from "@src/config/settingsNavigation";
import { buildGlobalSettingsSearchGroups } from "@src/config/settingsSearch";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { useOrg2CloudSignIn } from "@src/features/Org2Cloud/useOrg2CloudSignIn";
import { SIDEBAR_MEMORY_KIND, useSidebarMemoryEntry } from "@src/hooks/perf";
import { ArrowLeft01Icon, Search01Icon, Settings01Icon } from "@src/icons";
import SettingsSearchDropdown, {
  type SettingsSearchDropdownGroup,
  type SettingsSearchDropdownItem,
} from "@src/modules/shared/layouts/blocks/SettingsSearchDropdown";
import {
  type RenderedSettingsControl,
  collectRenderedSettingsControls,
  revealRenderedSettingsControl,
  revealSettingsControlWhenRendered,
} from "@src/modules/shared/layouts/blocks/SettingsSearchDropdown/settingsControlSearch";
import { devModeEnabledAtom } from "@src/store/platform/devModeAtom";
import { settingsReturnPathAtom } from "@src/store/ui/settingsNavigationAtom";
import { spotlightOpenAtom } from "@src/store/ui/uiAtom";

import SidebarBase from "../SidebarBase";
import {
  SidebarBottomBar,
  SidebarHeaderNavButton,
  SidebarList,
} from "../blocks";
import SidebarSettingsMenuButton from "../blocks/SidebarSettingsMenuButton";
import HoverAnimatedIcon, {
  triggerIconAnimation,
} from "../components/HoverAnimatedIcon";
import NavigationMenu from "../components/NavigationMenu";
import type { NavigationMenuItem } from "../components/NavigationMenu/config";
import SidebarAccountButton from "../connectors/SidebarAccountButton";
import { SidebarSearchShortcutTooltip } from "../connectors/WorkstationSidebarConnector/sidebarTabs";

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
      icon={Settings01Icon}
      iconName="settings"
      size={16}
      strokeWidth={2}
      className="text-text-1"
    />
  </button>
);

const SettingsFooterAccountMenu: React.FC = () => {
  const cloudAuth = useAtomValue(org2CloudAuthAtom);
  const handleSignIn = useOrg2CloudSignIn();
  const identity = cloudAuth
    ? (cloudAuth.profile?.displayName ??
      cloudAuth.profile?.primaryEmail ??
      cloudAuth.userId)
    : null;

  return (
    <SidebarSettingsMenuButton
      onSignIn={identity === null ? handleSignIn : undefined}
      renderTrigger={({ isOpen, onClick }) => (
        <SidebarAccountButton
          identity={identity}
          avatarUrl={cloudAuth?.profile?.avatarUrl}
          menuOpen={isOpen}
          onClick={onClick}
        />
      )}
    />
  );
};

const SettingsSidebar: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const settingsReturnPath = useAtomValue(settingsReturnPathAtom);
  const devModeEnabled = useAtomValue(devModeEnabledAtom);
  const setSpotlightOpen = useSetAtom(spotlightOpenAtom);
  const pendingSearchTargetRef = React.useRef<SettingsControlSearchItem | null>(
    null
  );
  const stopWaitingForTargetRef = React.useRef<(() => void) | null>(null);

  const navigationGroups = useMemo(
    () => buildSettingsNavigationGroups(t, devModeEnabled),
    [devModeEnabled, t]
  );
  const activeItemId = useMemo(
    () => getActiveSettingsNavigationItemId(location.pathname),
    [location.pathname]
  );
  const handleBack = useCallback(() => {
    navigate(settingsReturnPath || ROUTES.workStation.base.path);
  }, [navigate, settingsReturnPath]);

  const handleOpenSpotlight = useCallback(() => {
    setSpotlightOpen(true);
  }, [setSpotlightOpen]);

  const handleSelectNavigationItem = useCallback(
    (item: SettingsNavigationItem) => {
      pendingSearchTargetRef.current = null;
      stopWaitingForTargetRef.current?.();
      navigate(item.path);
    },
    [navigate]
  );

  const revealSearchTarget = useCallback((item: SettingsControlSearchItem) => {
    stopWaitingForTargetRef.current?.();
    stopWaitingForTargetRef.current = revealSettingsControlWhenRendered({
      targetId: item.targetId,
      searchKey: item.searchKey,
      label: item.label,
    });
  }, []);

  const handleSelectSettingsControl = useCallback(
    (item: SettingsControlSearchItem) => {
      stopWaitingForTargetRef.current?.();
      if (location.pathname === item.path) {
        revealSearchTarget(item);
        return;
      }
      pendingSearchTargetRef.current = item;
      navigate(item.path);
    },
    [location.pathname, navigate, revealSearchTarget]
  );

  React.useEffect(() => {
    const pendingTarget = pendingSearchTargetRef.current;
    if (!pendingTarget || pendingTarget.path !== location.pathname) return;
    pendingSearchTargetRef.current = null;
    revealSearchTarget(pendingTarget);
  }, [location.pathname, revealSearchTarget]);

  React.useEffect(
    () => () => {
      stopWaitingForTargetRef.current?.();
    },
    []
  );
  const settingsReturnItem = useMemo(
    () => (
      <SidebarHeaderNavButton
        icon={ArrowLeft01Icon}
        label={t("navigation:labels.settings")}
        onClick={handleBack}
      />
    ),
    [handleBack, t]
  );

  return (
    <SidebarBase
      onAddNew={handleOpenSpotlight}
      addIcon={Search01Icon}
      addLabel={t("common:actions.search")}
      addTooltipContent={
        <SidebarSearchShortcutTooltip
          searchLabel={t("common:actions.search")}
        />
      }
      hostTopBarLeadingContent={settingsReturnItem}
      macTopBarFollowingContent={
        <div className="shrink-0 px-3">{settingsReturnItem}</div>
      }
    >
      <SettingsRootBody
        navigationGroups={navigationGroups}
        activeItemId={activeItemId}
        searchScopeKey={location.pathname}
        onSelect={handleSelectNavigationItem}
        onSelectControl={handleSelectSettingsControl}
      />
      <SidebarBottomBar
        leftContent={<SettingsFooterAccountMenu />}
        rightActions={
          <SettingsFooterBackButton
            label={t("navigation:sidebar.bottomBar.settings")}
            onClick={handleBack}
          />
        }
      />
    </SidebarBase>
  );
};

export default SettingsSidebar;

interface SettingsRootBodyProps {
  navigationGroups: readonly SettingsNavigationGroup[];
  activeItemId: SettingsNavigationItemId;
  searchScopeKey: string;
  onSelect: (item: SettingsNavigationItem) => void;
  onSelectControl?: (item: SettingsControlSearchItem) => void;
}

interface SettingsControlSearchItem extends SettingsSearchDropdownItem {
  readonly kind: "control";
  readonly targetId?: string;
  readonly searchKey?: string;
}

interface SettingsNavigationSearchItem extends SettingsSearchDropdownItem {
  readonly kind: "navigation";
  readonly navigationItem: SettingsNavigationItem;
}

type SettingsSidebarSearchItem =
  | SettingsControlSearchItem
  | SettingsNavigationSearchItem;

export const SettingsRootBody: React.FC<SettingsRootBodyProps> = ({
  navigationGroups,
  activeItemId,
  searchScopeKey,
  onSelect,
  onSelectControl,
}) => {
  const { t } = useTranslation();
  const [renderedControls, setRenderedControls] = React.useState<
    readonly RenderedSettingsControl[]
  >([]);
  const appGroup = navigationGroups[0];
  const toMenuItems = useCallback(
    (items: readonly SettingsNavigationItem[]): NavigationMenuItem[] =>
      items.map((item) => ({
        id: item.id,
        key: item.id,
        label: item.label,
        icon: item.icon,
        dataTestId: item.dataTestId,
        routePath: item.path,
      })),
    []
  );
  const appSectionItems = useMemo(
    () => toMenuItems(appGroup?.items ?? []),
    [appGroup, toMenuItems]
  );
  const namedSections = useMemo(
    () =>
      navigationGroups.slice(1).map((group) => ({
        ...group,
        items: toMenuItems(group.items),
      })),
    [navigationGroups, toMenuItems]
  );
  const itemById = useMemo(
    () =>
      new Map(
        navigationGroups
          .flatMap((group) => group.items)
          .map((item) => [item.id, item])
      ),
    [navigationGroups]
  );
  const activeNavigationItem = itemById.get(activeItemId);

  const globalControlSearchGroups = useMemo(
    () =>
      buildGlobalSettingsSearchGroups(t, navigationGroups).map(
        (group): SettingsSearchDropdownGroup<SettingsControlSearchItem> => ({
          id: group.id,
          label: group.label,
          items: group.items.map((item) => ({
            id: item.id,
            label: item.label,
            path: item.path,
            icon: item.navigationItem.icon,
            groupId: group.id,
            searchTerms: item.searchTerms,
            kind: "control",
            searchKey: item.key,
          })),
        })
      ),
    [navigationGroups, t]
  );

  const searchGroups = useMemo<
    readonly SettingsSearchDropdownGroup<SettingsSidebarSearchItem>[]
  >(() => {
    const navigationSearchGroups = navigationGroups.map((group) => ({
      ...group,
      items: group.items.map<SettingsNavigationSearchItem>((item) => ({
        ...item,
        kind: "navigation",
        navigationItem: item,
      })),
    }));
    if (!activeNavigationItem) {
      return [...navigationSearchGroups, ...globalControlSearchGroups];
    }

    const globalSearchKeys = new Set(
      globalControlSearchGroups.flatMap((group) =>
        group.items.flatMap((item) => item.searchKey ?? [])
      )
    );

    const controlItems = renderedControls
      .filter(
        (control) =>
          !control.searchKeys.some((key) => globalSearchKeys.has(key))
      )
      .map<SettingsControlSearchItem>((control) => ({
        id: control.targetId,
        label: control.label,
        path: activeNavigationItem.path,
        icon: activeNavigationItem.icon,
        groupId: `controls-${activeNavigationItem.id}`,
        searchTerms: control.description ? [control.description] : undefined,
        kind: "control",
        targetId: control.targetId,
      }));

    return controlItems.length > 0
      ? [
          ...navigationSearchGroups,
          ...globalControlSearchGroups,
          {
            id: `controls-${activeNavigationItem.id}`,
            label: activeNavigationItem.label,
            items: controlItems,
          },
        ]
      : [...navigationSearchGroups, ...globalControlSearchGroups];
  }, [
    activeNavigationItem,
    globalControlSearchGroups,
    navigationGroups,
    renderedControls,
  ]);

  const handleSearchQueryChange = useCallback((query: string) => {
    setRenderedControls(
      query.trim().length > 0 ? collectRenderedSettingsControls() : []
    );
  }, []);

  const handleSelectSearchItem = useCallback(
    (item: SettingsSidebarSearchItem) => {
      if (item.kind === "navigation") {
        onSelect(item.navigationItem);
        return;
      }
      if (onSelectControl) {
        onSelectControl(item);
        return;
      }
      if (item.targetId) {
        requestAnimationFrame(() =>
          revealRenderedSettingsControl(item.targetId ?? "")
        );
      }
    },
    [onSelect, onSelectControl]
  );

  const handleItemClick = useCallback(
    (key: string) => {
      const item = itemById.get(key as SettingsNavigationItem["id"]);
      if (item) onSelect(item);
    },
    [itemById, onSelect]
  );

  const selectedKeys = useMemo(() => [activeItemId], [activeItemId]);
  const integrationItemCount = namedSections.reduce(
    (sum, section) => sum + section.items.length,
    0
  );

  useSidebarMemoryEntry({
    kind: SIDEBAR_MEMORY_KIND.SETTINGS,
    label: "Settings root",
    items: appSectionItems.length + integrationItemCount,
    sections: namedSections.length + 1,
    source: { activeItemId, appSectionItems, namedSections },
  });

  return (
    <>
      <div className="shrink-0 px-3 pt-1 pb-2">
        <SettingsSearchDropdown<SettingsSidebarSearchItem>
          key={searchScopeKey}
          variant="search-input"
          groups={searchGroups}
          onSelect={handleSelectSearchItem}
          onSearchQueryChange={handleSearchQueryChange}
          align="left"
        />
      </div>
      <SidebarList>
        <NavigationMenu
          items={appSectionItems}
          selectedKeys={selectedKeys}
          onMenuItemClick={handleItemClick}
        />
        {namedSections.map((section) => (
          <div key={section.id} className="mt-4">
            <div className="mb-2 px-2 text-[11px] font-medium tracking-wider text-text-1 uppercase">
              {section.label}
            </div>
            <NavigationMenu
              items={section.items}
              selectedKeys={selectedKeys}
              onMenuItemClick={handleItemClick}
            />
          </div>
        ))}
      </SidebarList>
    </>
  );
};
