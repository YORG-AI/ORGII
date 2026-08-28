import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import GitHubIcon from "@src/assets/channelIcons/github.svg";
import AnyIcon from "@src/components/AnyIcon";
import Button from "@src/components/Button";
import Dropdown from "@src/components/Dropdown";
import { DROPDOWN_CLASSES } from "@src/components/Dropdown/tokens";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import { ROUTES } from "@src/config/routes";
import {
  FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS,
  isSameFocusedChatGitEnvironment,
  resolveFocusedChatWorkstationRailInsetStyle,
  resolveFocusedChatWorkstationRailTrackClass,
  resolveFocusedChatWorkstationSectionOrder,
} from "@src/engines/ChatPanel/focusedChatWorkstationLayout";
import { getTerminalDisplayTitle } from "@src/engines/TerminalCore/types";
import { useActiveRepoRef } from "@src/hooks/git/useActiveRepoRef";
import { useBranchPullRequestStatus } from "@src/hooks/git/useBranchPullRequestStatus";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { useWorkingTreeDiffTotals } from "@src/hooks/git/useWorkingTreeDiffTotals";
import { useCloseTabWithGuard } from "@src/hooks/tabHost/useCloseTabWithGuard";
import {
  ArrowLeftDoubleIcon,
  ArrowRightDoubleIcon,
  File01Icon,
  FileDiffIcon,
  FolderClosedIcon,
  GitPullRequestIcon,
  HugeiconsIcon,
  InternetIcon,
  LayoutListIcon,
  SquareTerminalIcon,
} from "@src/icons";
import { openBranchSpotlight } from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { spotlightOpenAtom } from "@src/store/ui/uiAtom";
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
} from "../blocks";
import { WorkstationSections } from "./WorkstationSections";
import {
  getStoredRailCollapsed,
  persistRailCollapsed,
  resolveRailStatusDotClass,
} from "./railStorage";
import type {
  FocusedChatRailItem,
  FocusedChatRailSection,
  FocusedChatSessionContext,
  FocusedChatWorkstationRailProps,
} from "./types";

export type { FocusedChatSessionContext } from "./types";

const FOCUSED_CHAT_RAIL_SECTIONS = {
  session: { key: "session", label: null },
  tabs: { key: "tabs", label: null },
  workspace: { key: "workspace", label: null },
} as const;

const WORKSTATION_HOST_ROUTES: Record<WorkstationTabHost, string> = {
  code: ROUTES.workStation.code.path,
  browser: ROUTES.workStation.browser.path,
  project: ROUTES.workStation.project.path,
};

const GitHubRailIcon = ({
  size = 24,
  ...props
}: {
  size?: number;
  [key: string]: unknown;
}) => <GitHubIcon {...props} width={size} height={size} />;

function getRailTabFileName(tab: WorkStationTab): string | undefined {
  switch (tab.type) {
    case "file":
    case "git-diff":
      return (tab.data.filePath as string | undefined) || tab.title;
    case "directory":
      return "folder";
    case "settings":
      return "settings.json";
    default:
      return undefined;
  }
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

  // Selected state for the branch-switcher row: engaged on click, released
  // when the spotlight closes. The spotlight's own layer state is internal,
  // so a later unrelated spotlight open must not re-highlight the row.
  const spotlightOpen = useAtomValue(spotlightOpenAtom);
  const [branchSwitcherEngaged, setBranchSwitcherEngaged] = useState(false);
  if (branchSwitcherEngaged && !spotlightOpen) {
    // Render-time adjustment instead of an effect (react.dev guidance).
    setBranchSwitcherEngaged(false);
  }
  const branchSwitcherOpen = branchSwitcherEngaged && spotlightOpen;

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
  const sessionSharesLocalGitEnvironment = isSameFocusedChatGitEnvironment({
    localBranchName: activeBranchName,
    localRepoPath: activeRepoPath,
    sessionBranchName:
      sessionContext?.worktreeBranchName ?? sessionContext?.branchName,
    sessionRepoPath: sessionContext?.repoPath,
  });
  const sessionGitLookupEnabled = Boolean(
    (sessionContext?.worktreeBranchName ?? sessionContext?.branchName) &&
    sessionContext.repoPath &&
    !sessionSharesLocalGitEnvironment
  );
  const { ciStatus: sessionBranchCiStatus, pr: sessionBranchPullRequest } =
    useBranchPullRequestStatus({
      branchName: sessionGitLookupEnabled
        ? (sessionContext?.worktreeBranchName ?? sessionContext?.branchName)
        : undefined,
      repoPath: sessionGitLookupEnabled ? sessionContext?.repoPath : undefined,
    });
  const resolvedSessionBranchCiStatus = sessionSharesLocalGitEnvironment
    ? branchCiStatus
    : sessionGitLookupEnabled
      ? sessionBranchCiStatus
      : null;
  const resolvedSessionBranchPullRequest = sessionSharesLocalGitEnvironment
    ? branchPullRequest
    : sessionGitLookupEnabled
      ? sessionBranchPullRequest
      : null;

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
        icon: SquareTerminalIcon,
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
        icon: tab.type === "browser-session" ? InternetIcon : File01Icon,
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
        icon: FileDiffIcon,
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
              icon: GitPullRequestIcon,
              external: true,
              status: branchPullRequestStatus,
              onClick: () => void openExternalLink(branchPullRequest.url),
            },
          ]
        : []),
      {
        key: "terminal",
        label: t("common:tabs.terminal"),
        icon: SquareTerminalIcon,
        shortcut: getShortcutKeys("open_terminal_tab"),
        onClick: () => void WorkStationViewService.openTerminalTab(),
      },
      {
        key: "files",
        label: t("common:labels.files"),
        icon: FolderClosedIcon,
        shortcut: getShortcutKeys("open_file_folder_tab"),
        onClick: () => void WorkStationViewService.openFileFolderTab(),
      },
      {
        key: "browser",
        label: t("navigation:labels.browser"),
        icon: InternetIcon,
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

  const sessionPullRequestStatus = useMemo<
    FocusedChatRailItem["status"] | undefined
  >(() => {
    if (!resolvedSessionBranchPullRequest || !resolvedSessionBranchCiStatus) {
      return undefined;
    }
    const label =
      resolvedSessionBranchCiStatus === "success"
        ? t("common:git.pr.checks.passedShort")
        : resolvedSessionBranchCiStatus === "failure"
          ? t("common:git.pr.checks.failedShort")
          : resolvedSessionBranchCiStatus === "pending"
            ? t("common:git.pr.checks.runningShort")
            : resolvedSessionBranchCiStatus === "checking"
              ? t("common:git.pr.checks.checkingShort")
              : resolvedSessionBranchCiStatus === "none"
                ? t("common:git.pr.checks.noneShort")
                : t("common:git.pr.checks.unavailableShort");
    return {
      label,
      state: resolvedSessionBranchCiStatus,
      title: t("common:git.pr.checks.branchStatus", {
        number: resolvedSessionBranchPullRequest.number,
        status: label,
      }),
    };
  }, [resolvedSessionBranchCiStatus, resolvedSessionBranchPullRequest, t]);

  const sessionItems = useMemo<FocusedChatRailItem[]>(
    () =>
      resolvedSessionBranchPullRequest
        ? [
            {
              key: `session-pull-request:${resolvedSessionBranchPullRequest.number}`,
              label: t("common:git.pr.linkedBranch", {
                number: resolvedSessionBranchPullRequest.number,
              }),
              icon: GitPullRequestIcon,
              external: true,
              status: sessionPullRequestStatus,
              onClick: () =>
                void openExternalLink(resolvedSessionBranchPullRequest.url),
            },
          ]
        : [],
    [resolvedSessionBranchPullRequest, sessionPullRequestStatus, t]
  );

  const hasSessionEnvironment = Boolean(
    sessionContext?.repoName ||
    sessionContext?.branchName ||
    sessionContext?.worktreeBranchName ||
    sessionContext?.workItem
  );
  const sections = useMemo<FocusedChatRailSection[]>(() => {
    const localEnvironment: FocusedChatSessionContext = {
      repoName: activeRepoName,
      branchName: activeBranchName,
      // Same switcher as the workstation status bar's branch button.
      branchAction: {
        active: branchSwitcherOpen,
        label: t("common:workstation.switchLocalBranchTooltip"),
        onClick: () => {
          setBranchSwitcherEngaged(true);
          openBranchSpotlight();
        },
      },
    };
    return resolveFocusedChatWorkstationSectionOrder(
      openTabItems.length > 0,
      hasSessionEnvironment
    ).map((sectionKey) => ({
      ...FOCUSED_CHAT_RAIL_SECTIONS[sectionKey],
      label:
        sectionKey === "session"
          ? null
          : sectionKey === "workspace"
            ? t("navigation:labels.localEnvironment")
            : t("common:git.rail.openTabs"),
      items:
        sectionKey === "tabs"
          ? openTabItems
          : sectionKey === "workspace"
            ? workspaceItems
            : sessionItems,
      environment:
        sectionKey === "session"
          ? sessionContext
          : sectionKey === "workspace"
            ? localEnvironment
            : undefined,
    }));
  }, [
    activeBranchName,
    activeRepoName,
    branchSwitcherOpen,
    hasSessionEnvironment,
    openTabItems,
    sessionContext,
    sessionItems,
    t,
    workspaceItems,
  ]);

  const environmentLabel = t("navigation:labels.sessionEnvironment");
  const compactSections = useMemo<FocusedChatRailSection[]>(
    () =>
      sections.map((section) =>
        section.key === "session"
          ? { ...section, label: environmentLabel }
          : section
      ),
    [environmentLabel, sections]
  );
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
              <div
                className={`${DROPDOWN_CLASSES.optionsContainerOverlay} max-h-96`}
              >
                <WorkstationSections
                  compact
                  onRequestClose={() => setMenuOpen(false)}
                  sections={compactSections}
                />
              </div>
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
              icon={
                <HugeiconsIcon
                  icon={LayoutListIcon}
                  data-icon="layout-list"
                  size={14}
                  strokeWidth={2}
                />
              }
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
        data-workstation-trail-track
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
                  <HugeiconsIcon
                    icon={ArrowLeftDoubleIcon}
                    data-icon="chevrons-left"
                    size={14}
                    strokeWidth={1.75}
                  />
                ) : (
                  <HugeiconsIcon
                    icon={ArrowRightDoubleIcon}
                    data-icon="chevrons-right"
                    size={14}
                    strokeWidth={1.75}
                  />
                )}
              </WorkstationTrailIconButton>
            }
          />
          {collapsed ? (
            <div className="flex flex-col items-center gap-2">
              {workspaceItems.map((item) => {
                const icon = item.icon;
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
                    <AnyIcon icon={icon} size={16} strokeWidth={1.75} />
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
              <WorkstationSections sections={sections} />
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
