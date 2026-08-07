/**
 * useWorkStationLaunchActions
 *
 * Single source of truth for the WorkStation "launch" actions shared by the
 * empty-pool Launchpad (`WorkStationStartPage`) and the tab-bar `+` dropdown
 * (`TabBarPlusMenu`). Keeping both surfaces on the same ordered list is what
 * guarantees their items and icons stay in sync.
 *
 * Each action opens (or activates) a real `mainPane` tab, except the Browser
 * entries — the Browser host keeps its sessions in a separate store, so those
 * request a session (the Browser host is pre-mounted via `visitedModes`
 * seeding) instead of adding a `mainPane` tab.
 */
import { useSetAtom } from "jotai";
import {
  Box,
  FileDiff,
  FileSearch,
  Folder,
  Globe,
  LayoutGrid,
  ListTodo,
  type LucideIcon,
  ShieldOff,
  SquareTerminal,
} from "lucide-react";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { focusBrowserUrlBar } from "@src/modules/WorkStation/Browser/Panels/BrowserMainPane/components/WebUrlBar";
import { openEditorSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import {
  CODE_EDITOR_MAIN_TERMINAL_SESSION_ID,
  STORY_ORG_SCOPE,
  createExplorerTab,
  createProjectDashboardTab,
  createProjectWorkItemsIndexTab,
  createSearchSessionsTab,
  createSourceControlTab,
  createTerminalTab,
  openTab as openTabMutation,
  requestNewBrowserSessionAtom,
  workstationLayoutAtom,
} from "@src/store/workstation";
import type { WorkStationTab } from "@src/store/workstation/tabs";

export type WorkStationLaunchActionId =
  | "searchFile"
  | "searchSessions"
  | "explorer"
  | "sourceControl"
  | "terminal"
  | "newBrowserTab"
  | "newPrivateBrowserTab"
  | "workItems"
  | "projects";

export interface WorkStationLaunchAction {
  id: WorkStationLaunchActionId;
  icon: LucideIcon;
  label: string;
  /** Display string for the keyboard hint, when the action has one. */
  shortcut?: string;
  onClick: () => void;
}

/**
 * Visible launch entries, in display order, shared by the Launchpad and the
 * `+` menu so the two stay in sync. `newPrivateBrowserTab` is intentionally
 * omitted — the private-session feature stays available programmatically (the
 * hook still returns its action); we only hide the entrance.
 */
export const LAUNCHPAD_ACTION_IDS: readonly WorkStationLaunchActionId[] = [
  "sourceControl",
  "explorer",
  "searchFile",
  "searchSessions",
  "terminal",
  "newBrowserTab",
  "workItems",
  "projects",
];

export function useWorkStationLaunchActions(): WorkStationLaunchAction[] {
  const { t } = useTranslation("navigation");
  const requestNewBrowserSession = useSetAtom(requestNewBrowserSessionAtom);
  const setLayout = useSetAtom(workstationLayoutAtom);

  const openTabInMainPane = useCallback(
    (tab: WorkStationTab) => {
      setLayout((prev) => {
        if (!prev?.mainPane) return prev;
        return { ...prev, mainPane: openTabMutation(prev.mainPane, tab) };
      });
    },
    [setLayout]
  );

  const openBrowser = useCallback(
    (isPrivate: boolean) => {
      requestNewBrowserSession(isPrivate ? { isPrivate: true } : {});
      focusBrowserUrlBar();
    },
    [requestNewBrowserSession]
  );

  return useMemo<WorkStationLaunchAction[]>(
    () => [
      {
        id: "explorer",
        icon: Folder,
        label: t("common:labels.files"),
        shortcut: getShortcutKeys("open_file_folder_tab"),
        onClick: () => openTabInMainPane(createExplorerTab()),
      },
      {
        id: "searchFile",
        icon: FileSearch,
        label: t("workstation.plusMenu.searchFile"),
        shortcut: "⌘P",
        onClick: () => openEditorSpotlight(""),
      },
      {
        id: "searchSessions",
        icon: LayoutGrid,
        label: t("workstation.plusMenu.searchSessions"),
        onClick: () => openTabInMainPane(createSearchSessionsTab()),
      },
      {
        id: "sourceControl",
        icon: FileDiff,
        label: t("common:actions.review"),
        shortcut: getShortcutKeys("open_source_control_tab"),
        onClick: () =>
          openTabInMainPane(createSourceControlTab(0, { mode: "all-changes" })),
      },
      {
        id: "terminal",
        icon: SquareTerminal,
        label: t("common:tabs.terminal"),
        shortcut: getShortcutKeys("open_terminal_tab"),
        onClick: () =>
          openTabInMainPane(
            createTerminalTab(
              CODE_EDITOR_MAIN_TERMINAL_SESSION_ID,
              t("common:tabs.terminal")
            )
          ),
      },
      {
        id: "newBrowserTab",
        icon: Globe,
        label: t("labels.browser"),
        onClick: () => openBrowser(false),
      },
      {
        id: "newPrivateBrowserTab",
        icon: ShieldOff,
        label: t("workstation.plusMenu.newPrivateBrowserTab"),
        onClick: () => openBrowser(true),
      },
      {
        id: "workItems",
        icon: ListTodo,
        label: t("workstation.plusMenu.workItems"),
        onClick: () =>
          openTabInMainPane(
            createProjectWorkItemsIndexTab({ orgScope: STORY_ORG_SCOPE.ALL })
          ),
      },
      {
        id: "projects",
        icon: Box,
        label: t("workstation.plusMenu.projects"),
        onClick: () =>
          openTabInMainPane(
            createProjectDashboardTab({ orgScope: STORY_ORG_SCOPE.ALL })
          ),
      },
    ],
    [t, openTabInMainPane, openBrowser]
  );
}
