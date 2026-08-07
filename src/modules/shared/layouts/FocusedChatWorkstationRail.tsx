import { useAtomValue, useSetAtom } from "jotai";
import {
  ChevronsLeft,
  ChevronsRight,
  File,
  FileDiff,
  Folder,
  Globe,
  type LucideIcon,
  SquareTerminal,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { IconButton } from "@src/components/IconButton";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { ROUTES } from "@src/config/routes";
import { getTerminalDisplayTitle } from "@src/engines/TerminalCore/types";
import { useActiveRepoRef } from "@src/hooks/git/useActiveRepoRef";
import { useWorkingTreeDiffTotals } from "@src/hooks/git/useWorkingTreeDiffTotals";
import { useCloseTabWithGuard } from "@src/hooks/workStation/tabs/useCloseTabWithGuard";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import {
  CHAT_PANEL_SURFACE_KIND,
  activeChatPanelSurfaceAtom,
  chatPanelMaximizedAtom,
} from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { activeWorkspaceRootAtom } from "@src/store/workspace";
import { requestNewBrowserSessionAtom } from "@src/store/workstation";
import {
  closeTerminalSessionAtom,
  initializedTerminalIdsAtom,
  setActiveTerminalAtom,
  terminalSessionsAtom,
} from "@src/store/workstation/codeEditor/terminal";
import { codeEditorTerminalTargetAtom } from "@src/store/workstation/codeEditor/terminalTargetAtom";
import {
  type WorkstationTabHost,
  tabToHost,
} from "@src/store/workstation/tabHost";
import {
  focusTabAtom,
  tabRegistryAtom,
} from "@src/store/workstation/tabRegistry";
import type { WorkStationTab } from "@src/store/workstation/tabs/types";

const FOCUSED_CHAT_RAIL_COLLAPSED_KEY =
  "orgii:focusedChatWorkstationRailCollapsed";

const FOCUSED_CHAT_RAIL_SECTIONS = [
  { key: "tabs", label: "Open Tabs" },
  { key: "workspace" },
] as const;

type FocusedChatRailItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Keyboard hint shown in the expanded view (e.g. "⌘E"). */
  shortcut?: string;
  fileName?: string;
  onClick?: () => void;
  onClose?: () => void;
  /** Working-tree +/- shown after the label (the Review row). */
  additions?: number;
  deletions?: number;
};

const WORKSTATION_HOST_ROUTES: Record<WorkstationTabHost, string> = {
  code: ROUTES.workStation.code.path,
  browser: ROUTES.workStation.browser.path,
  project: ROUTES.workStation.project.path,
};

function getRailTabFileName(tab: WorkStationTab): string | undefined {
  switch (tab.type) {
    case "file":
    case "git-diff":
      return (tab.data.filePath as string | undefined) || tab.title;
    case "directory":
      return "folder";
    case "output":
      return "output.log";
    case "settings":
      return "settings.json";
    default:
      return undefined;
  }
}

function getStoredRailCollapsed(): boolean {
  try {
    const stored = localStorage.getItem(FOCUSED_CHAT_RAIL_COLLAPSED_KEY);
    return stored == null ? true : stored === "true";
  } catch {
    return true;
  }
}

function persistRailCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(FOCUSED_CHAT_RAIL_COLLAPSED_KEY, String(collapsed));
  } catch {
    // Ignore storage errors
  }
}

export function FocusedChatWorkstationRail() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(getStoredRailCollapsed);

  const chatPanelSurface = useAtomValue(activeChatPanelSurfaceAtom);
  const shouldHideForProjectSurface =
    chatPanelSurface.kind === CHAT_PANEL_SURFACE_KIND.PROJECT ||
    chatPanelSurface.kind === CHAT_PANEL_SURFACE_KIND.PROJECT_ORG ||
    chatPanelSurface.kind === CHAT_PANEL_SURFACE_KIND.WORK_ITEM;

  const activeWorkspaceRoot = useAtomValue(activeWorkspaceRootAtom);

  // Working-tree +/- shown on the Review row, matching the branch pill's badge.
  const { repoId, repoPath } = useActiveRepoRef();
  const { additions: reviewAdditions, deletions: reviewDeletions } =
    useWorkingTreeDiffTotals(repoId, repoPath);

  const tabEntries = useAtomValue(tabRegistryAtom);
  const terminalSessions = useAtomValue(terminalSessionsAtom);
  const initializedTerminalIds = useAtomValue(initializedTerminalIdsAtom);
  const closeTab = useCloseTabWithGuard();
  const setFocusedTab = useSetAtom(focusTabAtom);
  const setActiveTerminal = useSetAtom(setActiveTerminalAtom);
  const setTerminalTarget = useSetAtom(codeEditorTerminalTargetAtom);
  const terminalTarget = useAtomValue(codeEditorTerminalTargetAtom);
  const closeTerminalSession = useSetAtom(closeTerminalSessionAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const setChatPanelMaximized = useSetAtom(chatPanelMaximizedAtom);
  const requestNewBrowserSession = useSetAtom(requestNewBrowserSessionAtom);

  const visibleTabs = useMemo(
    () => tabEntries.filter(({ tab }) => !tab.hideWhenOthersExist),
    [tabEntries]
  );

  const openTabs = useMemo(
    () => visibleTabs.filter(({ tab }) => tab.pinned !== true),
    [visibleTabs]
  );

  const openWorkstationHost = useCallback(
    (host: WorkstationTabHost) => {
      setStationMode("my-station");
      setChatPanelMaximized(false);
      navigate(WORKSTATION_HOST_ROUTES[host]);
    },
    [navigate, setChatPanelMaximized, setStationMode]
  );

  const openWorkstationTab = useCallback(
    (tab: WorkStationTab) => {
      setFocusedTab({ tabId: tab.id });
      openWorkstationHost(tabToHost(tab));
    },
    [openWorkstationHost, setFocusedTab]
  );

  const openTerminalSession = useCallback(
    (sessionId: string) => {
      setActiveTerminal(sessionId);
      setTerminalTarget({ kind: "pty", ptySessionId: sessionId });
      setFocusedTab({ tabId: "terminal:main" });
      openWorkstationHost("code");
    },
    [openWorkstationHost, setActiveTerminal, setFocusedTab, setTerminalTarget]
  );

  // Kill a terminal session the same way the terminal sidebar does:
  // close the PTY (killPty + local removal) and drop the terminal target
  // when the session being killed is the active one.
  const closePtySession = useCallback(
    (sessionId: string) => {
      void closeTerminalSession(sessionId);
      if (
        terminalTarget?.kind === "pty" &&
        terminalTarget.ptySessionId === sessionId
      ) {
        setTerminalTarget(null);
      }
    },
    [closeTerminalSession, setTerminalTarget, terminalTarget]
  );

  const openTabItems = useMemo<FocusedChatRailItem[]>(() => {
    const terminalItems = terminalSessions
      .filter(
        (session) =>
          !session.readOnly &&
          initializedTerminalIds.has(session.id) &&
          (!session.isDefaultSession || session.hasUserInput === true)
      )
      .map((session) => ({
        key: `terminal-session:${session.id}`,
        label: getTerminalDisplayTitle(session),
        icon: SquareTerminal,
        onClick: () => openTerminalSession(session.id),
        onClose: () => closePtySession(session.id),
      }));

    // Excluded from Open Tabs:
    // - "terminal": running terminal sessions (with foreground process names +
    //   kill action) are shown instead, mirroring the terminal sidebar.
    // - "start" (Launchpad) and "explorer" (the "Files" home tab): neither
    //   points at a specific file, so they're noise here. Opening an actual
    //   file spawns a "file" tab, which is kept.
    // - "source-control": the workspace section below always exposes the same
    //   Review action, so listing its open tab here would be a duplicate.
    const tabItems = openTabs
      .filter(
        ({ tab }) =>
          tab.type !== "terminal" &&
          tab.type !== "start" &&
          tab.type !== "explorer" &&
          tab.type !== "source-control"
      )
      .slice(0, 6)
      .map(({ tab }) => ({
        key: tab.id,
        label: tab.title,
        icon: tab.type === "browser-session" ? Globe : File,
        fileName: getRailTabFileName(tab),
        onClick: () => openWorkstationTab(tab),
        onClose: () => void closeTab({ tabId: tab.id }),
      }));

    return [...tabItems, ...terminalItems];
  }, [
    closePtySession,
    closeTab,
    initializedTerminalIds,
    openTabs,
    openTerminalSession,
    openWorkstationTab,
    terminalSessions,
  ]);

  const browserTab = visibleTabs.find(
    ({ tab }) => tab.type === "browser-session"
  );

  // Every rail action goes to the existing tab of its kind, or creates one —
  // all through the unified tab system (WorkStationViewService / mainPane).
  // Icons, labels, and keys mirror the Launchpad / `+` menu entries.
  const workspaceItems = useMemo<FocusedChatRailItem[]>(
    () => [
      {
        key: "changes",
        label: t("common:actions.review"),
        icon: FileDiff,
        shortcut: getShortcutKeys("open_source_control_tab"),
        additions: reviewAdditions,
        deletions: reviewDeletions,
        onClick: () => void WorkStationViewService.openSourceControlTab(),
      },
      {
        key: "terminal",
        label: t("common:tabs.terminal"),
        icon: SquareTerminal,
        shortcut: getShortcutKeys("open_terminal_tab"),
        onClick: () => void WorkStationViewService.openTerminalTab(),
      },
      {
        key: "files",
        label: t("common:labels.files"),
        icon: Folder,
        shortcut: getShortcutKeys("open_file_folder_tab"),
        onClick: () => void WorkStationViewService.openFileFolderTab(),
      },
      {
        key: "browser",
        label: t("navigation:labels.browser"),
        icon: Globe,
        onClick: browserTab
          ? () => openWorkstationTab(browserTab.tab)
          : () => {
              openWorkstationHost("browser");
              requestNewBrowserSession({});
            },
      },
    ],
    [
      t,
      browserTab,
      openWorkstationHost,
      openWorkstationTab,
      requestNewBrowserSession,
      reviewAdditions,
      reviewDeletions,
    ]
  );

  const sections = [
    ...(openTabItems.length > 0
      ? [{ ...FOCUSED_CHAT_RAIL_SECTIONS[0], items: openTabItems }]
      : []),
    {
      ...FOCUSED_CHAT_RAIL_SECTIONS[1],
      label: activeWorkspaceRoot?.name ?? "Workspace",
      items: workspaceItems,
    },
  ];

  if (shouldHideForProjectSurface) {
    return null;
  }

  return (
    <div className="pointer-events-none absolute right-1 top-12 z-20 hidden xl:flex">
      <div
        className={`pointer-events-auto flex bg-bg-2/90 transition-all ${
          collapsed
            ? "flex-col items-center rounded-xl border-[1px] border-border-1 p-1"
            : "w-64 flex-col rounded-xl border-[1px] border-border-1 p-1"
        }`}
      >
        <button
          type="button"
          className="text-text-tertiary hover:text-text-primary mb-1 flex h-7 w-7 items-center justify-center self-end rounded-lg transition hover:bg-fill-2"
          onClick={() =>
            setCollapsed((value) => {
              const nextValue = !value;
              persistRailCollapsed(nextValue);
              return nextValue;
            })
          }
          aria-label={
            collapsed ? "Expand workstation info" : "Collapse workstation info"
          }
        >
          {collapsed ? <ChevronsLeft size={14} /> : <ChevronsRight size={14} />}
        </button>

        {collapsed ? (
          <div className="flex flex-col items-center gap-1">
            {workspaceItems.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.key}
                  type="button"
                  className={`flex h-7 w-7 items-center justify-center rounded-lg transition ${
                    item.onClick
                      ? "text-text-tertiary hover:text-text-primary hover:bg-fill-2"
                      : "text-text-tertiary/50 cursor-default"
                  }`}
                  onClick={item.onClick}
                  disabled={!item.onClick}
                  aria-label={item.label}
                >
                  {item.fileName ? (
                    <FileTypeIcon fileName={item.fileName} size="medium" />
                  ) : (
                    <Icon size={16} />
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="space-y-3">
            {sections.map((section) => (
              <div key={section.key}>
                <div className="text-text-tertiary mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wide">
                  {section.label}
                </div>
                <div className="space-y-1">
                  {section.items.map((item) => {
                    const Icon = item.icon;
                    const row = (
                      <div
                        key={item.key}
                        className={`group flex h-7 min-w-0 cursor-pointer items-center gap-1.5 overflow-hidden rounded-lg px-2 transition-colors duration-150 ${
                          item.onClick
                            ? "text-text-1 hover:bg-fill-2"
                            : "cursor-default text-text-3"
                        }`}
                        onClick={item.onClick}
                      >
                        <div className="shrink-0 text-text-1">
                          {item.fileName ? (
                            <FileTypeIcon
                              fileName={item.fileName}
                              size="small"
                            />
                          ) : (
                            <Icon size={14} />
                          )}
                        </div>
                        <span className="min-w-0 flex-1 truncate text-[12px]">
                          {item.label}
                        </span>
                        {(item.additions ?? 0) > 0 ||
                        (item.deletions ?? 0) > 0 ? (
                          <DiffStatsBadge
                            additions={item.additions}
                            deletions={item.deletions}
                            variant="plain"
                            size="sm"
                            reserveValueWidth={false}
                            className="shrink-0"
                          />
                        ) : null}
                        {item.onClose && (
                          <IconButton
                            size="sm"
                            variant="defaultTreeRow"
                            className="ml-1 shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                            onClick={(event) => {
                              event.stopPropagation();
                              item.onClose?.();
                            }}
                            aria-label={`Close ${item.label}`}
                          >
                            <X size={12} />
                          </IconButton>
                        )}
                      </div>
                    );

                    // Shortcuts are no longer shown inline — reveal them on
                    // hover instead. Rows without a shortcut render bare.
                    return item.shortcut ? (
                      <Tooltip
                        key={item.key}
                        content={
                          <KeyboardShortcutTooltipContent
                            label={item.label}
                            shortcut={item.shortcut}
                          />
                        }
                        position="left"
                        framedPanel
                        mouseEnterDelay={200}
                        smartPlacement
                        // Nudge further left than the default 8px gap so the
                        // tooltip clears the rail (the popup positions via
                        // `left`, so a transform doesn't fight it).
                        style={{ transform: "translateX(-12px)" }}
                      >
                        {row}
                      </Tooltip>
                    ) : (
                      row
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
