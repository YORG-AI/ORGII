import { useAtomValue, useSetAtom } from "jotai";
import {
  ChevronsLeft,
  ChevronsRight,
  File,
  FileDiff,
  Folder,
  FolderGit2,
  GitBranch,
  Globe,
  LayoutList,
  type LucideIcon,
  SquareTerminal,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import Button from "@src/components/Button";
import DiffStatsBadge from "@src/components/DiffStatsBadge";
import Dropdown from "@src/components/Dropdown";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import FileTypeIcon from "@src/components/FileTypeIcon";
import { IconButton } from "@src/components/IconButton";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { ROUTES } from "@src/config/routes";
import { EDITOR_TAB_CANVAS_BG_CLASS } from "@src/config/workstation/tokens";
import {
  FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS,
  resolveFocusedChatWorkstationRailTrackClass,
  resolveFocusedChatWorkstationSectionOrder,
} from "@src/engines/ChatPanel/focusedChatWorkstationLayout";
import { getTerminalDisplayTitle } from "@src/engines/TerminalCore/types";
import { useActiveRepoRef } from "@src/hooks/git/useActiveRepoRef";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { useWorkingTreeDiffTotals } from "@src/hooks/git/useWorkingTreeDiffTotals";
import { useCloseTabWithGuard } from "@src/hooks/workStation/tabs/useCloseTabWithGuard";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { activeWorkspaceRootAtom } from "@src/store/workspace";
import { requestNewBrowserSessionAtom } from "@src/store/workstation";
import {
  closeTerminalSessionAtom,
  initializedTerminalIdsAtom,
  setActiveTerminalAtom,
  terminalSessionsAtom,
} from "@src/store/workstation/codeEditor/terminal";
import {
  clearTerminalTargetReferencesAtom,
  codeEditorTerminalTargetAtom,
} from "@src/store/workstation/codeEditor/terminalTargetAtom";
import {
  type WorkstationTabHost,
  tabToHost,
} from "@src/store/workstation/tabHost";
import {
  focusTabAtom,
  tabRegistryAtom,
} from "@src/store/workstation/tabRegistry";
import type { WorkStationTab } from "@src/store/workstation/tabs/types";

const FOCUSED_CHAT_RAIL_SECTIONS = {
  tabs: { key: "tabs", label: "Open Tabs" },
  workspace: { key: "workspace", label: null },
} as const;
const FOCUSED_CHAT_RAIL_COLLAPSED_KEY =
  "orgii:focusedChatWorkstationRailCollapsed";

type FocusedChatRailItem = {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Keyboard hint shown in a tooltip (e.g. "⌘E"). */
  shortcut?: string;
  fileName?: string;
  onClick?: () => void;
  onClose?: () => void;
  /** Working-tree +/- shown after the label (the Review row). */
  additions?: number;
  deletions?: number;
};

type FocusedChatRailSection = {
  key: string;
  label: string | null;
  items: FocusedChatRailItem[];
};

interface FocusedChatWorkstationRailProps {
  /** Header host for the narrow-layout pinned trigger. */
  compactMenuHost: HTMLSpanElement | null;
  /** Rail-column host for the conversation scroll navigator. */
  conversationMinimapHostRef: (node: HTMLDivElement | null) => void;
}

interface WorkstationSectionsProps {
  branchName?: string;
  compact?: boolean;
  onRequestClose?: () => void;
  repoName?: string;
  sections: FocusedChatRailSection[];
}

const WORKSTATION_HOST_ROUTES: Record<WorkstationTabHost, string> = {
  code: ROUTES.workStation.code.path,
  browser: ROUTES.workStation.browser.path,
  project: ROUTES.workStation.project.path,
};

const RAIL_ICON_BUTTON_CLASS =
  "flex h-[26px] w-[26px] items-center justify-center rounded-lg text-text-1 transition-colors hover:bg-fill-2";

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
    return localStorage.getItem(FOCUSED_CHAT_RAIL_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

function persistRailCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(FOCUSED_CHAT_RAIL_COLLAPSED_KEY, String(collapsed));
  } catch {
    // The responsive control still works when storage is unavailable.
  }
}

function WorkspaceContextRow({
  compact = false,
  icon: Icon,
  label,
}: {
  compact?: boolean;
  icon: LucideIcon;
  label: string;
}) {
  return (
    <div
      className={
        compact
          ? "flex h-8 min-w-0 items-center gap-2 overflow-hidden rounded-md px-1.5 text-text-1"
          : "flex h-7 min-w-0 items-center gap-1.5 overflow-hidden rounded-lg px-2 text-text-1"
      }
      title={label}
    >
      <Icon className="shrink-0" size={14} strokeWidth={1.75} />
      <span
        className={`min-w-0 flex-1 truncate ${
          compact ? "text-[13px]" : "text-[12px]"
        }`}
      >
        {label}
      </span>
    </div>
  );
}

function WorkstationItemRow({
  compact = false,
  item,
  onRequestClose,
}: {
  compact?: boolean;
  item: FocusedChatRailItem;
  onRequestClose?: () => void;
}) {
  const Icon = item.icon;
  const runAction = () => {
    onRequestClose?.();
    item.onClick?.();
  };

  const action = (
    <button
      type="button"
      className={
        compact
          ? `${DROPDOWN_CLASSES.item} min-w-0 flex-1 text-left ${
              item.onClick
                ? DROPDOWN_CLASSES.itemHover
                : `${DROPDOWN_CLASSES.itemDisabled} text-text-3`
            }`
          : `flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left text-[12px] ${
              item.onClick ? "text-text-1" : "cursor-default text-text-3"
            }`
      }
      onClick={runAction}
      disabled={!item.onClick}
      role={compact ? "menuitem" : undefined}
    >
      <span className="flex shrink-0 items-center text-text-1">
        {item.fileName ? (
          <FileTypeIcon fileName={item.fileName} size="small" />
        ) : (
          <Icon size={14} strokeWidth={1.75} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {(item.additions ?? 0) > 0 || (item.deletions ?? 0) > 0 ? (
        <DiffStatsBadge
          additions={item.additions}
          deletions={item.deletions}
          variant="plain"
          size="sm"
          reserveValueWidth={false}
          valueClassName="font-normal"
          className="shrink-0"
        />
      ) : null}
    </button>
  );

  return (
    <div
      className={
        compact
          ? "group flex min-w-0 items-center"
          : `group flex h-7 min-w-0 items-center rounded-lg transition-colors duration-150 ${
              item.onClick ? "focus-within:bg-fill-2 hover:bg-fill-2" : ""
            }`
      }
    >
      {item.shortcut ? (
        <Tooltip
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
        >
          {action}
        </Tooltip>
      ) : (
        action
      )}
      {item.onClose && (
        <IconButton
          size="sm"
          variant="defaultTreeRow"
          className={`shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 ${
            compact ? "ml-0.5" : "mr-1"
          }`}
          onClick={(event) => {
            event.stopPropagation();
            item.onClose?.();
          }}
          aria-label={`Close ${item.label}`}
          role={compact ? "menuitem" : undefined}
        >
          <X size={12} />
        </IconButton>
      )}
    </div>
  );
}

function WorkstationSections({
  branchName,
  compact = false,
  onRequestClose,
  repoName,
  sections,
}: WorkstationSectionsProps) {
  return (
    <div
      className={compact ? "space-y-2 p-1" : "space-y-3 px-1 pb-1"}
      role={compact ? "menu" : undefined}
    >
      {sections.map((section) => (
        <section key={section.key}>
          {section.label && (
            <div
              className={`text-[11px] font-medium uppercase tracking-wide text-text-3 ${
                compact ? "mb-1 px-1.5" : "mb-1.5 px-1"
              }`}
            >
              {section.label}
            </div>
          )}
          {section.key === "workspace" && (repoName || branchName) && (
            <div className={compact ? "mb-0.5 space-y-0.5" : "mb-1 space-y-1"}>
              {repoName && (
                <WorkspaceContextRow
                  compact={compact}
                  icon={FolderGit2}
                  label={repoName}
                />
              )}
              {branchName && (
                <WorkspaceContextRow
                  compact={compact}
                  icon={GitBranch}
                  label={branchName}
                />
              )}
            </div>
          )}
          <div className={compact ? "space-y-0.5" : "space-y-1"}>
            {section.items.map((item) => (
              <WorkstationItemRow
                key={item.key}
                compact={compact}
                item={item}
                onRequestClose={onRequestClose}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function FocusedChatWorkstationRail({
  compactMenuHost,
  conversationMinimapHostRef,
}: FocusedChatWorkstationRailProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(getStoredRailCollapsed);

  const activeWorkspaceRoot = useAtomValue(activeWorkspaceRootAtom);
  const repoName =
    activeWorkspaceRoot?.repo?.name ?? activeWorkspaceRoot?.name ?? undefined;
  const { currentBranch } = useRepoSelection({ autoLoad: false });
  const branchName = currentBranch || undefined;

  const { repoId, repoPath: activeRepoPath } = useActiveRepoRef();
  const { additions: reviewAdditions, deletions: reviewDeletions } =
    useWorkingTreeDiffTotals(repoId, activeRepoPath);

  const tabEntries = useAtomValue(tabRegistryAtom);
  const terminalSessions = useAtomValue(terminalSessionsAtom);
  const initializedTerminalIds = useAtomValue(initializedTerminalIdsAtom);
  const closeTab = useCloseTabWithGuard();
  const setFocusedTab = useSetAtom(focusTabAtom);
  const setActiveTerminal = useSetAtom(setActiveTerminalAtom);
  const setTerminalTarget = useSetAtom(codeEditorTerminalTargetAtom);
  const clearTerminalTargetReferences = useSetAtom(
    clearTerminalTargetReferencesAtom
  );
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

  const closePtySession = useCallback(
    (sessionId: string) => {
      void closeTerminalSession(sessionId);
      clearTerminalTargetReferences(sessionId);
    },
    [clearTerminalTargetReferences, closeTerminalSession]
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

  const sections = useMemo<FocusedChatRailSection[]>(
    () =>
      resolveFocusedChatWorkstationSectionOrder(openTabItems.length > 0).map(
        (sectionKey) => ({
          ...FOCUSED_CHAT_RAIL_SECTIONS[sectionKey],
          items: sectionKey === "tabs" ? openTabItems : workspaceItems,
        })
      ),
    [openTabItems, workspaceItems]
  );

  const environmentLabel = t("navigation:labels.environment");
  const toggleCollapsed = () => {
    setCollapsed((current) => {
      const next = !current;
      persistRailCollapsed(next);
      return next;
    });
  };

  const compactMenu = compactMenuHost
    ? createPortal(
        <span className="inline-flex @[1100px]/focusedchat:hidden">
          <Dropdown
            position="bottom-end"
            popupVisible={menuOpen}
            onVisibleChange={setMenuOpen}
            className={`${DROPDOWN_CLASSES.menuPanelWithHeaderBase} w-72`}
            droplist={
              <>
                <div className="flex h-10 items-center border-b border-border-2 px-3">
                  <span className="text-[13px] font-medium text-text-2">
                    {environmentLabel}
                  </span>
                </div>
                <div
                  className={`${DROPDOWN_CLASSES.optionsContainerOverlay} max-h-96 py-2`}
                >
                  <WorkstationSections
                    branchName={branchName}
                    compact
                    onRequestClose={() => setMenuOpen(false)}
                    repoName={repoName}
                    sections={sections}
                  />
                </div>
              </>
            }
          >
            <Button
              htmlType="button"
              variant="tertiary"
              size="small"
              iconOnly
              className={menuOpen ? "!bg-fill-1 !text-primary-6" : ""}
              aria-label={environmentLabel}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              icon={<LayoutList size={14} strokeWidth={2} />}
            />
          </Dropdown>
        </span>,
        compactMenuHost
      )
    : null;

  return (
    <>
      {compactMenu}
      {/* Button-controlled 256px/44px tracks only: the trail intentionally
          has no drag handle or continuously resizable width. */}
      <div
        data-workstation-pane-control
        className={`relative flex h-full shrink-0 flex-col items-start transition-[width] duration-200 ease-out motion-reduce:transition-none ${resolveFocusedChatWorkstationRailTrackClass(
          collapsed
        )}`}
      >
        <aside
          aria-label={environmentLabel}
          className={`hidden max-h-full w-full flex-col overflow-hidden rounded-xl border border-border-1 p-1 @[1100px]/focusedchat:flex ${EDITOR_TAB_CANVAS_BG_CLASS}`}
        >
          <div
            className={`mb-1 flex h-7 shrink-0 items-center ${
              collapsed ? "justify-center" : "justify-between px-1"
            }`}
          >
            {!collapsed && (
              <span className="min-w-0 truncate px-1 text-[11px] font-medium uppercase tracking-wide text-text-3">
                {environmentLabel}
              </span>
            )}
            <button
              type="button"
              className={RAIL_ICON_BUTTON_CLASS}
              onClick={toggleCollapsed}
              aria-label={t(
                collapsed
                  ? "common:actions.expandWorkstationInfo"
                  : "common:actions.collapseWorkstationInfo",
                {
                  defaultValue: collapsed
                    ? "Expand workstation info"
                    : "Collapse workstation info",
                }
              )}
              aria-expanded={!collapsed}
            >
              {collapsed ? (
                <ChevronsLeft size={14} strokeWidth={1.75} />
              ) : (
                <ChevronsRight size={14} strokeWidth={1.75} />
              )}
            </button>
          </div>
          {collapsed ? (
            <div className="flex flex-col items-center gap-2">
              {workspaceItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={RAIL_ICON_BUTTON_CLASS}
                    onClick={item.onClick}
                    aria-label={item.label}
                  >
                    <Icon size={16} strokeWidth={1.75} />
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="min-h-0 overflow-y-auto scrollbar-hide">
              <WorkstationSections
                branchName={branchName}
                repoName={repoName}
                sections={sections}
              />
            </div>
          )}
        </aside>
        <div
          ref={conversationMinimapHostRef}
          data-focused-chat-conversation-minimap-host
          className={FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS}
        />
      </div>
    </>
  );
}
