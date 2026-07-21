import { useAtomValue, useSetAtom } from "jotai";
import { Plus } from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Dropdown from "@src/components/Dropdown";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { focusBrowserUrlBar } from "@src/modules/WorkStation/Browser/Panels/BrowserMainPane/components/WebUrlBar";
import { TabBarTrailingIconButton } from "@src/modules/WorkStation/shared/TabBar/components/TabBarTrailingIconButton";
import { openEditorSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { CODE_EDITOR_TOUR_TARGETS } from "@src/scaffold/Tutorials/codeEditorTourConfig";
import {
  STORY_ORG_SCOPE,
  createProjectDashboardTab,
  createProjectWorkItemsIndexTab,
  openWorkstationTabAtom,
  presentedWorkstationWorkspaceKeyAtom,
  requestNewBrowserSessionAtom,
} from "@src/store/workstation";
import type { WorkStationTab } from "@src/store/workstation/tabs";

import { TabBarPlusMenuItems } from "./TabBarPlusMenuItems";
import {
  DEFAULT_TAB_BAR_PLUS_MENU_ITEMS,
  getVisibleTabBarPlusMenuItems,
} from "./menuModel";
import type { TabBarPlusMenuItem } from "./menuModel";

export type { TabBarPlusMenuItem } from "./menuModel";

const WORKSTATION_NEW_TAB_EVENT = "workstation-new-tab";

export interface TabBarPlusMenuProps {
  items?: readonly TabBarPlusMenuItem[];
}

const TabBarPlusMenuComponent: React.FC<TabBarPlusMenuProps> = ({
  items = DEFAULT_TAB_BAR_PLUS_MENU_ITEMS,
}) => {
  const { t } = useTranslation("navigation");
  const requestNewBrowserSession = useSetAtom(requestNewBrowserSessionAtom);
  const openTab = useSetAtom(openWorkstationTabAtom);
  const workspace = useAtomValue(presentedWorkstationWorkspaceKeyAtom);
  const [menuVisible, setMenuVisible] = useState(false);
  const close = useCallback(() => setMenuVisible(false), []);

  const openTabInMainPane = useCallback(
    (tab: WorkStationTab) => {
      openTab({ workspace, tab });
    },
    [openTab, workspace]
  );

  const onSelect = useMemo<Record<TabBarPlusMenuItem, () => void>>(
    () => ({
      searchFile: () => {
        openEditorSpotlight("");
        close();
      },
      newBrowserTab: () => {
        requestNewBrowserSession({});
        focusBrowserUrlBar();
        close();
      },
      newPrivateBrowserTab: () => {
        requestNewBrowserSession({ isPrivate: true });
        focusBrowserUrlBar();
        close();
      },
      workItems: () => {
        openTabInMainPane(
          createProjectWorkItemsIndexTab({ orgScope: STORY_ORG_SCOPE.ALL })
        );
        close();
      },
      projects: () => {
        openTabInMainPane(
          createProjectDashboardTab({ orgScope: STORY_ORG_SCOPE.ALL })
        );
        close();
      },
    }),
    [close, openTabInMainPane, requestNewBrowserSession]
  );

  useEffect(() => {
    const handler = () => setMenuVisible((open) => !open);
    window.addEventListener(WORKSTATION_NEW_TAB_EVENT, handler);
    return () => window.removeEventListener(WORKSTATION_NEW_TAB_EVENT, handler);
  }, []);

  const visibleItems = useMemo(
    () => getVisibleTabBarPlusMenuItems(items),
    [items]
  );
  const labels = useMemo<Record<TabBarPlusMenuItem, string>>(
    () => ({
      searchFile: t("workstation.plusMenu.searchFile"),
      newBrowserTab: t("workstation.plusMenu.newBrowserTab"),
      newPrivateBrowserTab: t("workstation.plusMenu.newPrivateBrowserTab"),
      workItems: t("workstation.plusMenu.workItems"),
      projects: t("workstation.plusMenu.projects"),
    }),
    [t]
  );
  const triggerLabel = t("workstation.plusMenu.title");
  const droplist = (
    <div
      className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.wideMenuClass}`}
    >
      <div className={DROPDOWN_CLASSES.itemsColumn}>
        <TabBarPlusMenuItems
          items={visibleItems}
          labels={labels}
          onSelect={onSelect}
        />
      </div>
    </div>
  );

  return (
    <Dropdown
      droplist={droplist}
      position="bottom-end"
      trigger="click"
      popupVisible={menuVisible}
      onVisibleChange={setMenuVisible}
      getPopupContainer={() => document.body}
      avoidViewportOverflow
    >
      <span
        className="inline-flex"
        data-tour-target={CODE_EDITOR_TOUR_TARGETS.plusMenu}
      >
        <TabBarTrailingIconButton
          title={triggerLabel}
          shortcutId="new_tab"
          tooltipDisabled={menuVisible}
          active={menuVisible}
          className="flex-shrink-0"
        >
          <Plus size={HEADER_ICON_SIZE.md} strokeWidth={2} />
        </TabBarTrailingIconButton>
      </span>
    </Dropdown>
  );
};

export const TabBarPlusMenu = memo(TabBarPlusMenuComponent);
TabBarPlusMenu.displayName = "TabBarPlusMenu";
