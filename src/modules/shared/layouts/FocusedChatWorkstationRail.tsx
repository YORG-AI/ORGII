import { useAtomValue, useSetAtom } from "jotai";
import {
  ChevronsLeft,
  ChevronsRight,
  File,
  GitBranch,
  Globe,
  type LucideIcon,
  Terminal,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { IconButton } from "@src/components/IconButton";
import { ROUTES } from "@src/config/routes";
import { getTerminalDisplayTitle } from "@src/engines/TerminalCore/types";
import { useCloseTabWithGuard } from "@src/hooks/workStation/tabs/useCloseTabWithGuard";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  type BottomPanelTab,
  type PrimarySidebarTabKey,
  workStationBottomPanelTabPersistAtom,
  workStationEditorSecondaryCollapsedPersistAtom,
  workStationPrimarySidebarCollapsedPersistAtom,
  workStationPrimarySidebarTabAtom,
} from "@src/store/ui/workStationAtom";
import { activeWorkspaceRootAtom } from "@src/store/workspace";
import { type DockFilter, dockFilterAtom } from "@src/store/workstation";
import {
  initializedTerminalIdsAtom,
  setActiveTerminalAtom,
  terminalSessionsAtom,
} from "@src/store/workstation/codeEditor/terminal";
import { codeEditorTerminalTargetAtom } from "@src/store/workstation/codeEditor/terminalTargetAtom";
import { tabToHost } from "@src/store/workstation/tabHost";
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
  fileName?: string;
  onClick?: () => void;
  onClose?: () => void;
};

const WORKSTATION_HOST_ROUTES: Record<DockFilter, string> = {
  all: ROUTES.workStation.base.path,
  code: ROUTES.workStation.code.path,
  browser: ROUTES.workStation.browser.path,
  data: ROUTES.workStation.database.path,
  project: ROUTES.workStation.project.path,
};

function getRailTabFileName(tab: WorkStationTab): string | undefined {
  switch (tab.type) {
    case "file":
    case "git-diff":
      return (tab.data.filePath as string | undefined) || tab.title;
    case "directory":
      return "folder";
    case "terminal":
      return "terminal.sh";
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
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useState(getStoredRailCollapsed);

  const activeWorkspaceRoot = useAtomValue(activeWorkspaceRootAtom);
  const tabEntries = useAtomValue(tabRegistryAtom);
  const terminalSessions = useAtomValue(terminalSessionsAtom);
  const initializedTerminalIds = useAtomValue(initializedTerminalIdsAtom);
  const closeTab = useCloseTabWithGuard();
  const setFocusedTab = useSetAtom(focusTabAtom);
  const setActiveTerminal = useSetAtom(setActiveTerminalAtom);
  const setTerminalTarget = useSetAtom(codeEditorTerminalTargetAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const setChatPanelMaximized = useSetAtom(chatPanelMaximizedAtom);
  const setDockFilter = useSetAtom(dockFilterAtom);
  const setPrimarySidebarTab = useSetAtom(workStationPrimarySidebarTabAtom);
  const setPrimarySidebarCollapsed = useSetAtom(
    workStationPrimarySidebarCollapsedPersistAtom
  );
  const setBottomPanelTab = useSetAtom(workStationBottomPanelTabPersistAtom);
  const setBottomPanelCollapsed = useSetAtom(
    workStationEditorSecondaryCollapsedPersistAtom
  );

  const visibleTabs = useMemo(
    () => tabEntries.filter(({ tab }) => !tab.hideWhenOthersExist),
    [tabEntries]
  );

  const openTabs = useMemo(
    () => visibleTabs.filter(({ tab }) => tab.pinned !== true),
    [visibleTabs]
  );

  const openWorkstationHost = useCallback(
    (host: DockFilter) => {
      setStationMode("my-station");
      setChatPanelMaximized(false);
      setDockFilter(host);
      navigate(WORKSTATION_HOST_ROUTES[host]);
    },
    [navigate, setChatPanelMaximized, setDockFilter, setStationMode]
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
        icon: Terminal,
        onClick: () => openTerminalSession(session.id),
      }));

    const tabItems = openTabs.slice(0, 6).map(({ tab }) => ({
      key: tab.id,
      label: tab.title,
      icon:
        tab.type === "terminal"
          ? Terminal
          : tab.type === "browser-session"
            ? Globe
            : File,
      fileName: getRailTabFileName(tab),
      onClick: () => openWorkstationTab(tab),
      onClose:
        tab.closable === false
          ? undefined
          : () => void closeTab({ tabId: tab.id }),
    }));

    return [...tabItems, ...terminalItems];
  }, [
    closeTab,
    initializedTerminalIds,
    openTabs,
    openTerminalSession,
    openWorkstationTab,
    terminalSessions,
  ]);

  const handlePrimarySidebarClick = useCallback(
    (tab: PrimarySidebarTabKey) => {
      setPrimarySidebarTab(tab);
      setPrimarySidebarCollapsed(false);
      openWorkstationHost("code");
    },
    [openWorkstationHost, setPrimarySidebarCollapsed, setPrimarySidebarTab]
  );

  const handleBottomPanelClick = useCallback(
    (tab: BottomPanelTab) => {
      setBottomPanelTab(tab);
      setBottomPanelCollapsed(false);
      openWorkstationHost("code");
    },
    [openWorkstationHost, setBottomPanelCollapsed, setBottomPanelTab]
  );

  const sourceControlTab = visibleTabs.find(
    ({ tab }) => tab.id === "source-control:changes"
  );
  const browserTab = visibleTabs.find(
    ({ tab }) => tab.type === "browser-session"
  );

  const workspaceItems = useMemo<FocusedChatRailItem[]>(
    () => [
      {
        key: "changes",
        label: "Changes",
        icon: GitBranch,
        onClick: sourceControlTab
          ? () => openWorkstationTab(sourceControlTab.tab)
          : () => openWorkstationHost("code"),
      },
      {
        key: "browser",
        label: "Browser",
        icon: Globe,
        onClick: browserTab
          ? () => openWorkstationTab(browserTab.tab)
          : () => openWorkstationHost("browser"),
      },
      {
        key: "terminal",
        label: "Terminal",
        icon: Terminal,
        onClick: () => handleBottomPanelClick("terminal"),
      },
      {
        key: "files",
        label: "Files",
        icon: File,
        onClick: () => handlePrimarySidebarClick("files"),
      },
    ],
    [
      browserTab,
      handleBottomPanelClick,
      handlePrimarySidebarClick,
      openWorkstationHost,
      openWorkstationTab,
      sourceControlTab,
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
                    return (
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
