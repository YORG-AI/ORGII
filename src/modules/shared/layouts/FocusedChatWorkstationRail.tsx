import { useAtomValue, useSetAtom } from "jotai";
import {
  ArrowUpRight,
  CheckCircle2,
  ChevronsLeft,
  ChevronsRight,
  CircleSlash,
  File,
  FileDiff,
  Folder,
  FolderKanban,
  GitBranch,
  GitPullRequest,
  Globe,
  LayoutList,
  LoaderCircle,
  type LucideIcon,
  SquareTerminal,
  X,
  XCircle,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import GitHubIcon from "@src/assets/channelIcons/github.svg";
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
import {
  FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS,
  resolveFocusedChatWorkstationRailInsetStyle,
  resolveFocusedChatWorkstationRailTrackClass,
  resolveFocusedChatWorkstationSectionOrder,
} from "@src/engines/ChatPanel/focusedChatWorkstationLayout";
import { getTerminalDisplayTitle } from "@src/engines/TerminalCore/types";
import { useActiveRepoRef } from "@src/hooks/git/useActiveRepoRef";
import { useBranchPullRequestStatus } from "@src/hooks/git/useBranchPullRequestStatus";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { useWorkingTreeDiffTotals } from "@src/hooks/git/useWorkingTreeDiffTotals";
import { useCloseTabWithGuard } from "@src/hooks/workStation/tabs/useCloseTabWithGuard";
import type { BranchCiStatus } from "@src/services/git/branchPullRequestStatus";
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
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import {
  WORKSTATION_TRAIL_ICON_BUTTON_CLASS,
  WorkstationTrailBody,
  WorkstationTrailHeader,
  WorkstationTrailIconButton,
  WorkstationTrailSurface,
} from "./blocks";

const FOCUSED_CHAT_RAIL_SECTIONS = {
  tabs: { key: "tabs", label: null },
  workspace: { key: "workspace", label: null },
} as const;
const FOCUSED_CHAT_RAIL_COLLAPSED_KEY =
  "orgii:focusedChatWorkstationRailCollapsed";

type FocusedChatRailIcon = React.JSXElementConstructor<
  React.ComponentProps<LucideIcon>
>;

type FocusedChatRailItem = {
  key: string;
  label: string;
  icon: FocusedChatRailIcon;
  /** Keyboard hint shown in a tooltip (e.g. "⌘E"). */
  shortcut?: string;
  fileName?: string;
  onClick?: () => void;
  onClose?: () => void;
  closeLabel?: string;
  /** Working-tree +/- shown after the label (the Review row). */
  additions?: number;
  deletions?: number;
  external?: boolean;
  status?: {
    label: string;
    state: BranchCiStatus;
    title: string;
  };
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
  /** Active session scope moved out of the transcript's former context row. */
  sessionContext?: FocusedChatSessionContext;
  /** Height of overlaid chat chrome that the rail must remain below. */
  topInset?: number;
}

export interface FocusedChatSessionContext {
  branchName?: string;
  repoName?: string;
  workItem?: {
    label: string;
    onClick?: () => void;
    statusLabel?: string;
  };
}

interface WorkstationSectionsProps {
  branchName?: string;
  compact?: boolean;
  onRequestClose?: () => void;
  repoName?: string;
  sections: FocusedChatRailSection[];
  workItem?: FocusedChatSessionContext["workItem"];
}

const WORKSTATION_HOST_ROUTES: Record<WorkstationTabHost, string> = {
  code: ROUTES.workStation.code.path,
  browser: ROUTES.workStation.browser.path,
  project: ROUTES.workStation.project.path,
};

const GitHubRailIcon = ({
  size = 24,
  ...props
}: React.ComponentProps<LucideIcon>) => (
  <GitHubIcon {...props} width={size} height={size} />
);

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
  onClick,
  onRequestClose,
  testId,
}: {
  compact?: boolean;
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  onRequestClose?: () => void;
  testId?: string;
}) {
  const className = compact
    ? "flex h-8 min-w-0 items-center gap-2 overflow-hidden rounded-md px-1.5 text-text-1"
    : "flex h-7 min-w-0 items-center gap-1.5 overflow-hidden rounded-lg px-2 text-text-1";
  const content = (
    <>
      <Icon className="shrink-0" size={14} strokeWidth={1.75} />
      <span
        className={`min-w-0 flex-1 truncate ${
          compact ? "text-[13px]" : "text-[12px]"
        }`}
      >
        {label}
      </span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={`${className} w-full text-left transition-colors hover:bg-fill-2`}
        title={label}
        data-testid={testId}
        role={compact ? "menuitem" : undefined}
        onClick={() => {
          onRequestClose?.();
          onClick();
        }}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={className} title={label} data-testid={testId}>
      {content}
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
      {item.status ? <RailItemStatus status={item.status} /> : null}
      {item.external ? (
        <ArrowUpRight
          aria-hidden
          className="shrink-0 text-text-3"
          size={13}
          strokeWidth={1.75}
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
          aria-label={item.closeLabel}
          role={compact ? "menuitem" : undefined}
        >
          <X size={12} />
        </IconButton>
      )}
    </div>
  );
}

function RailItemStatus({
  status,
}: {
  status: NonNullable<FocusedChatRailItem["status"]>;
}) {
  const commonProps = {
    "aria-hidden": true,
    className: "shrink-0",
    size: 12,
    strokeWidth: 2,
  } as const;
  const icon =
    status.state === "success" ? (
      <CheckCircle2 {...commonProps} />
    ) : status.state === "failure" ? (
      <XCircle {...commonProps} />
    ) : status.state === "checking" || status.state === "pending" ? (
      <LoaderCircle {...commonProps} className="shrink-0 animate-spin" />
    ) : (
      <CircleSlash {...commonProps} />
    );
  const colorClass =
    status.state === "success"
      ? "text-success-6"
      : status.state === "failure"
        ? "text-danger-6"
        : status.state === "checking" || status.state === "pending"
          ? "text-warning-6"
          : "text-text-3";

  return (
    <span
      className={`flex shrink-0 items-center gap-1 text-[11px] ${colorClass}`}
      title={status.title}
      aria-label={status.title}
    >
      {icon}
      <span>{status.label}</span>
    </span>
  );
}

function resolveRailStatusDotClass(state: BranchCiStatus): string {
  switch (state) {
    case "success":
      return "bg-success-6";
    case "failure":
      return "bg-danger-6";
    case "checking":
    case "pending":
      return "animate-pulse bg-warning-6";
    default:
      return "bg-fill-3";
  }
}

function WorkstationSections({
  branchName,
  compact = false,
  onRequestClose,
  repoName,
  sections,
  workItem,
}: WorkstationSectionsProps) {
  return (
    <div
      className={compact ? "space-y-2 p-1" : "space-y-3"}
      role={compact ? "menu" : undefined}
    >
      {sections.map((section) => (
        <section
          key={section.key}
          className={compact ? "space-y-0.5" : "space-y-1"}
        >
          {section.label && (
            <div
              className={`text-[11px] font-medium uppercase tracking-wide text-text-3 ${
                compact ? "px-1.5" : "px-1"
              }`}
            >
              {section.label}
            </div>
          )}
          {section.key === "workspace" &&
            (repoName || branchName || workItem) && (
              <>
                {repoName && (
                  <WorkspaceContextRow
                    compact={compact}
                    icon={Folder}
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
                {workItem && (
                  <WorkspaceContextRow
                    compact={compact}
                    icon={FolderKanban}
                    label={`${workItem.label}${
                      workItem.statusLabel ? ` · ${workItem.statusLabel}` : ""
                    }`}
                    onClick={workItem.onClick}
                    onRequestClose={onRequestClose}
                    testId="session-active-work-item-pill"
                  />
                )}
              </>
            )}
          {section.items.map((item) => (
            <WorkstationItemRow
              key={item.key}
              compact={compact}
              item={item}
              onRequestClose={onRequestClose}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

export function FocusedChatWorkstationRail({
  compactMenuHost,
  conversationMinimapHostRef,
  sessionContext,
  topInset = 0,
}: FocusedChatWorkstationRailProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(getStoredRailCollapsed);

  const activeWorkspaceRoot = useAtomValue(activeWorkspaceRootAtom);
  const activeRepoName =
    activeWorkspaceRoot?.repo?.name ?? activeWorkspaceRoot?.name ?? undefined;
  const { currentBranch } = useRepoSelection({ autoLoad: false });
  const activeBranchName = currentBranch || undefined;
  const repoName = sessionContext?.repoName ?? activeRepoName;
  const branchName = sessionContext?.branchName ?? activeBranchName;

  const { repoId, repoPath: activeRepoPath } = useActiveRepoRef();
  const { additions: reviewAdditions, deletions: reviewDeletions } =
    useWorkingTreeDiffTotals(repoId, activeRepoPath);
  const {
    ciStatus: branchCiStatus,
    compareUrl: branchCompareUrl,
    pr: branchPullRequest,
  } = useBranchPullRequestStatus({
    branchName: activeBranchName,
    repoId,
    repoPath: activeRepoPath,
  });

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
        closeLabel: t("common:git.rail.closeItem", {
          label: getTerminalDisplayTitle(session),
        }),
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
        closeLabel: t("common:git.rail.closeItem", {
          label: tab.title,
        }),
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
    t,
    terminalSessions,
  ]);

  const browserTab = visibleTabs.find(
    ({ tab }) => tab.type === "browser-session"
  );

  const branchPullRequestStatus = useMemo<
    FocusedChatRailItem["status"] | undefined
  >(() => {
    if (!branchPullRequest || !branchCiStatus) return undefined;
    const label =
      branchCiStatus === "success"
        ? t("common:git.pr.checks.passedShort")
        : branchCiStatus === "failure"
          ? t("common:git.pr.checks.failedShort")
          : branchCiStatus === "pending"
            ? t("common:git.pr.checks.runningShort")
            : branchCiStatus === "checking"
              ? t("common:git.pr.checks.checkingShort")
              : branchCiStatus === "none"
                ? t("common:git.pr.checks.noneShort")
                : t("common:git.pr.checks.unavailableShort");
    return {
      label,
      state: branchCiStatus,
      title: t("common:git.pr.checks.branchStatus", {
        number: branchPullRequest.number,
        status: label,
      }),
    };
  }, [branchCiStatus, branchPullRequest, t]);

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
      ...(branchCompareUrl
        ? [
            {
              key: "compare-branch",
              label: t("common:git.actions.compareBranch"),
              icon: GitHubRailIcon,
              external: true,
              onClick: () => void openExternalLink(branchCompareUrl),
            },
          ]
        : []),
      ...(branchPullRequest
        ? [
            {
              key: `pull-request:${branchPullRequest.number}`,
              label: `#${branchPullRequest.number}`,
              icon: GitPullRequest,
              external: true,
              status: branchPullRequestStatus,
              onClick: () => void openExternalLink(branchPullRequest.url),
            },
          ]
        : []),
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
      branchCompareUrl,
      branchPullRequest,
      branchPullRequestStatus,
    ]
  );

  const sections = useMemo<FocusedChatRailSection[]>(
    () =>
      resolveFocusedChatWorkstationSectionOrder(openTabItems.length > 0).map(
        (sectionKey) => ({
          ...FOCUSED_CHAT_RAIL_SECTIONS[sectionKey],
          label: sectionKey === "tabs" ? t("common:git.rail.openTabs") : null,
          items: sectionKey === "tabs" ? openTabItems : workspaceItems,
        })
      ),
    [openTabItems, t, workspaceItems]
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
                    workItem={sessionContext?.workItem}
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
        style={resolveFocusedChatWorkstationRailInsetStyle(topInset)}
      >
        <WorkstationTrailSurface
          as="aside"
          aria-label={environmentLabel}
          className="hidden @[1100px]/focusedchat:flex"
        >
          <WorkstationTrailHeader
            title={environmentLabel}
            collapsed={collapsed}
            actions={
              <WorkstationTrailIconButton
                onClick={toggleCollapsed}
                aria-label={t(
                  collapsed
                    ? "common:git.rail.expand"
                    : "common:git.rail.collapse"
                )}
                aria-expanded={!collapsed}
              >
                {collapsed ? (
                  <ChevronsLeft size={14} strokeWidth={1.75} />
                ) : (
                  <ChevronsRight size={14} strokeWidth={1.75} />
                )}
              </WorkstationTrailIconButton>
            }
          />
          {collapsed ? (
            <div className="flex flex-col items-center gap-2">
              {workspaceItems.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.key}
                    type="button"
                    className={`${WORKSTATION_TRAIL_ICON_BUTTON_CLASS} relative`}
                    onClick={item.onClick}
                    aria-label={
                      item.status
                        ? `${item.label}, ${item.status.label}`
                        : item.label
                    }
                    title={item.status?.title ?? item.label}
                  >
                    <Icon size={16} strokeWidth={1.75} />
                    {item.status ? (
                      <span
                        aria-hidden
                        className={`absolute bottom-1 right-1 h-1.5 w-1.5 rounded-full ring-1 ring-bg-1 ${resolveRailStatusDotClass(
                          item.status.state
                        )}`}
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : (
            <WorkstationTrailBody>
              <WorkstationSections
                branchName={branchName}
                repoName={repoName}
                sections={sections}
                workItem={sessionContext?.workItem}
              />
            </WorkstationTrailBody>
          )}
        </WorkstationTrailSurface>
        <div
          ref={conversationMinimapHostRef}
          data-focused-chat-conversation-minimap-host
          className={FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS}
        />
      </div>
    </>
  );
}
