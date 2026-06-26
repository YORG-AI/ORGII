/**
 * TabBarPlusMenu
 *
 * Trailing `+` button for the unified workstation tab bar. Opens a tiny
 * palette with quick-action items. Each action adds (or activates) a tab in
 * `mainPane`; `AppShell` then swaps in the matching host content via
 * `activeHostAtom`.
 *
 * Menu items:
 *   - `"searchFile"` → open the Spotlight file search flow.
 *   - `"newBrowserTab"` → `requestNewBrowserSession({})` for a blank
 *     regular session.
 *   - `"newPrivateBrowserTab"` → `requestNewBrowserSession({ isPrivate:
 *     true })` for an incognito session. Browser-only semantics — only
 *     rendered when this item is included.
 *   - `"workItems"` → open the workspace-scope Work Items index tab.
 *   - `"projects"` → open the workspace-scope Projects dashboard tab.
 *
 * Surfaces:
 *   - **All Tabs** mode renders the full palette with file search, regular
 *     browser tab, private browser tab, work items, and projects.
 *   - **Browser** mode renders a Browser-focused palette with `newBrowserTab`
 *     and `newPrivateBrowserTab` only.
 *   - Other modes (Code / Data / Project) do **not** show a `+` at all.
 *
 * Keyboard: ⌘T (`new_tab`) opens whichever instance of this menu is
 * currently mounted. The global keydown listener dispatches
 * `workstation-new-tab` from any `/orgii/workstation*` route (see
 * `useTabShortcuts.handleGoToCreateSession`); we listen for it here so
 * the shortcut is owned exclusively by the `+` menu — host-specific
 * "new tab" semantics (Code file palette, Database add-connection,
 * Project create-project) are intentionally NOT bound to ⌘T.
 */
import { useSetAtom } from "jotai";
import {
  Box,
  FileSearch,
  Globe,
  ListTodo,
  Plus,
  ShieldOff,
} from "lucide-react";
import React, { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Dropdown from "@src/components/Dropdown";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import KeyBadge from "@src/components/KeyBadge";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { focusBrowserUrlBar } from "@src/modules/WorkStation/Browser/Panels/BrowserMainPane/components/WebUrlBar";
import { TabBarTrailingIconButton } from "@src/modules/WorkStation/shared/TabBar/components/TabBarTrailingIconButton";
import { openEditorSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { CODE_EDITOR_TOUR_TARGETS } from "@src/scaffold/Tutorials/codeEditorTourConfig";
import {
  STORY_ORG_SCOPE,
  createProjectDashboardTab,
  createProjectWorkItemsIndexTab,
  openTab as openTabMutation,
  requestNewBrowserSessionAtom,
  workstationLayoutAtom,
} from "@src/store/workstation";
import type { WorkStationTab } from "@src/store/workstation/tabs";

const WORKSTATION_NEW_TAB_EVENT = "workstation-new-tab";

export type TabBarPlusMenuItem =
  | "searchFile"
  | "newBrowserTab"
  | "newPrivateBrowserTab"
  | "workItems"
  | "projects";

const DEFAULT_ITEMS: readonly TabBarPlusMenuItem[] = [
  "searchFile",
  "newBrowserTab",
  "newPrivateBrowserTab",
  "workItems",
  "projects",
];

const KNOWN_ITEMS: readonly TabBarPlusMenuItem[] = [
  "searchFile",
  "newBrowserTab",
  "newPrivateBrowserTab",
  "workItems",
  "projects",
];

export interface TabBarPlusMenuProps {
  /** Menu items to render. Defaults to the full All-Tabs palette. */
  items?: readonly TabBarPlusMenuItem[];
}

interface MenuItemContentProps {
  icon: React.ReactNode;
  label: React.ReactNode;
}

function MenuItemContent({ icon, label }: MenuItemContentProps) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {icon}
      <span className="truncate">{label}</span>
    </span>
  );
}

const TabBarPlusMenuComponent: React.FC<TabBarPlusMenuProps> = ({
  items = DEFAULT_ITEMS,
}) => {
  const { t } = useTranslation("navigation");
  const requestNewBrowserSession = useSetAtom(requestNewBrowserSessionAtom);
  const setLayout = useSetAtom(workstationLayoutAtom);
  const [menuVisible, setMenuVisible] = useState(false);

  const close = useCallback(() => {
    setMenuVisible(false);
  }, []);

  // Add (or activate) a tab in the single `mainPane` pool. AppShell's
  // `activeHostAtom` will then swap the visible host content to match.
  const openTabInMainPane = useCallback(
    (tab: WorkStationTab) => {
      setLayout((prev) => {
        if (!prev?.mainPane) return prev;
        return { ...prev, mainPane: openTabMutation(prev.mainPane, tab) };
      });
    },
    [setLayout]
  );

  const handleNewBrowserTab = useCallback(() => {
    requestNewBrowserSession({});
    focusBrowserUrlBar();
    close();
  }, [close, requestNewBrowserSession]);

  const handleNewPrivateBrowserTab = useCallback(() => {
    requestNewBrowserSession({ isPrivate: true });
    focusBrowserUrlBar();
    close();
  }, [close, requestNewBrowserSession]);

  const handleOpenWorkItems = useCallback(() => {
    openTabInMainPane(
      createProjectWorkItemsIndexTab({ orgScope: STORY_ORG_SCOPE.ALL })
    );
    close();
  }, [close, openTabInMainPane]);

  const handleOpenProjects = useCallback(() => {
    openTabInMainPane(
      createProjectDashboardTab({ orgScope: STORY_ORG_SCOPE.ALL })
    );
    close();
  }, [close, openTabInMainPane]);

  const handleSearchFile = useCallback(() => {
    openEditorSpotlight("");
    close();
  }, [close]);

  // ⌘T (`new_tab`) is exclusively bound to opening this menu. Whether the
  // bridge route or the dock filter route triggered it, the rule is the
  // same: toggle the palette open. Only one TabBarPlusMenu is mounted at
  // a time per surface (All Tabs vs Browser), so there is no double-fire.
  useEffect(() => {
    const handler = () => setMenuVisible((open) => !open);
    window.addEventListener(WORKSTATION_NEW_TAB_EVENT, handler);
    return () => {
      window.removeEventListener(WORKSTATION_NEW_TAB_EVENT, handler);
    };
  }, []);

  const triggerLabel = t("workstation.plusMenu.title");

  const visibleItems = useMemo(
    () => items.filter((item) => KNOWN_ITEMS.includes(item)),
    [items]
  );

  const droplist = (
    <div
      className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.wideMenuClass}`}
    >
      <div className={DROPDOWN_CLASSES.itemsColumn}>
        {visibleItems.includes("searchFile") && (
          <button
            type="button"
            onClick={handleSearchFile}
            className={DROPDOWN_CLASSES.menuActionItem}
          >
            <MenuItemContent
              icon={<FileSearch size={HEADER_ICON_SIZE.sm} />}
              label={t("workstation.plusMenu.searchFile")}
            />
            <KeyBadge keys="⌘P" showSeparator={false} />
          </button>
        )}

        {visibleItems.includes("newBrowserTab") && (
          <button
            type="button"
            onClick={handleNewBrowserTab}
            className={DROPDOWN_CLASSES.menuActionItem}
          >
            <MenuItemContent
              icon={<Globe size={HEADER_ICON_SIZE.sm} />}
              label={t("workstation.plusMenu.newBrowserTab")}
            />
          </button>
        )}

        {visibleItems.includes("newPrivateBrowserTab") && (
          <button
            type="button"
            onClick={handleNewPrivateBrowserTab}
            className={DROPDOWN_CLASSES.menuActionItem}
          >
            <MenuItemContent
              icon={<ShieldOff size={HEADER_ICON_SIZE.sm} />}
              label={t("workstation.plusMenu.newPrivateBrowserTab")}
            />
          </button>
        )}

        {visibleItems.includes("workItems") && (
          <button
            type="button"
            onClick={handleOpenWorkItems}
            className={DROPDOWN_CLASSES.menuActionItem}
          >
            <MenuItemContent
              icon={<ListTodo size={HEADER_ICON_SIZE.sm} />}
              label={t("workstation.plusMenu.workItems")}
            />
          </button>
        )}

        {visibleItems.includes("projects") && (
          <button
            type="button"
            onClick={handleOpenProjects}
            className={DROPDOWN_CLASSES.menuActionItem}
          >
            <MenuItemContent
              icon={<Box size={HEADER_ICON_SIZE.sm} />}
              label={t("workstation.plusMenu.projects")}
            />
          </button>
        )}
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
