import { useAtomValue, useSetAtom } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import { useResizeHandle } from "@src/hooks/ui";
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
import { VerticalResizeHandle } from "@src/scaffold/Resize";
import { WorkStationViewService } from "@src/services/workStation/WorkStationViewService";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import {
  closeMiniTerminalAtom,
  miniTerminalHostMountedAtom,
  miniTerminalVisibleAtom,
  openMiniTerminalAtom,
} from "@src/store/ui/miniTerminalAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { spotlightOpenAtom } from "@src/store/ui/uiAtom";
import { activeWorkspaceRootAtom } from "@src/store/workspace";
import { requestNewBrowserSessionAtom } from "@src/store/workstation";
import {
  closeTerminalSessionAtom,
  initializedTerminalIdsAtom,
  terminalSessionsAtom,
} from "@src/store/workstation/codeEditor/terminal";
import { clearTerminalTargetReferencesAtom } from "@src/store/workstation/codeEditor/terminalTargetAtom";
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
  WORKSTATION_TRAIL_WIDTH,
  WorkstationTrailBody,
  WorkstationTrailHeader,
  WorkstationTrailIconButton,
  WorkstationTrailSurface,
} from "../blocks";
import { WorkstationGroupToggle } from "./WorkstationGroupToggle";
import { WorkstationSections } from "./WorkstationSections";
import { WorkstationTrailTerminal } from "./WorkstationTrailTerminal";
import {
  getStoredRailCollapsed,
  getStoredRailMinWidth,
  getStoredRailWidth,
  persistRailCollapsed,
  persistRailMinWidth,
  persistRailWidth,
  resolveRailStatusDotClass,
} from "./railStorage";
import {
  WORKSTATION_TRAIL_WIDTH_LIMITS,
  clampTrailWidth,
  resolveTrailMinWidth,
  resolveTrailWidthVariables,
} from "./trailWidth";
import type {
  FocusedChatRailItem,
  FocusedChatRailSection,
  FocusedChatSessionContext,
  FocusedChatWorkstationRailProps,
} from "./types";
import { useWorkstationTrailMenu } from "./useWorkstationTrailMenu";

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
  // Expanded width and the user's own floor. `minWidth` only ever gates the
  // width the user is actively changing — "set current width as minimum"
  // pins the trail where it stands and never resizes it.
  const [minWidth, setMinWidth] = useState(() =>
    resolveTrailMinWidth(getStoredRailMinWidth())
  );
  const [width, setWidth] = useState(() =>
    clampTrailWidth(
      getStoredRailWidth(),
      resolveTrailMinWidth(getStoredRailMinWidth())
    )
  );
  // Latest width for `onResizeEnd`, which must persist without re-subscribing
  // the drag listeners on every RAF-throttled width update.
  const widthRef = useRef(width);

  // Drag: state only, so the RAF-throttled stream never touches storage.
  const handleWidthChange = useCallback((next: number) => {
    widthRef.current = next;
    setWidth(next);
  }, []);
  const handleResizeEnd = useCallback(() => {
    persistRailWidth(widthRef.current);
  }, []);
  const { handleMouseDown: handleResizeMouseDown, isResizing } =
    useResizeHandle(width, handleWidthChange, {
      direction: "horizontal",
      minSize: minWidth,
      maxSize: WORKSTATION_TRAIL_WIDTH_LIMITS.max,
      // The trail sits at the pane's right edge: dragging left grows it.
      isReversed: true,
      onResizeEnd: handleResizeEnd,
    });

  /** Menu-driven width change: clamp and persist immediately. */
  const applyWidth = useCallback(
    (next: number) => {
      const clamped = clampTrailWidth(next, minWidth);
      widthRef.current = clamped;
      setWidth(clamped);
      persistRailWidth(clamped);
    },
    [minWidth]
  );

  /** Pin the current width as the floor. Deliberately does not resize. */
  const setCurrentWidthAsMinimum = useCallback(() => {
    const nextMinimum = resolveTrailMinWidth(width);
    setMinWidth(nextMinimum);
    persistRailMinWidth(nextMinimum);
  }, [width]);

  /**
   * Restore the shipped width. The user-set floor is cleared with it — a
   * floor above 256px would otherwise leave this command a no-op with no
   * way back from the menu.
   */
  const restoreDefaultWidth = useCallback(() => {
    const nextMinimum = WORKSTATION_TRAIL_WIDTH_LIMITS.floor;
    const nextWidth = WORKSTATION_TRAIL_WIDTH_LIMITS.default;
    widthRef.current = nextWidth;
    setMinWidth(nextMinimum);
    setWidth(nextWidth);
    persistRailMinWidth(nextMinimum);
    persistRailWidth(nextWidth);
  }, []);

  const [collapsedGroupKeys, setCollapsedGroupKeys] = useState<Set<string>>(
    () => new Set()
  );

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
  const clearTerminalTargetReferences = useSetAtom(
    clearTerminalTargetReferencesAtom
  );
  const closeTerminalSession = useSetAtom(closeTerminalSessionAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const setChatPanelMaximized = useSetAtom(chatPanelMaximizedAtom);
  const requestNewBrowserSession = useSetAtom(requestNewBrowserSessionAtom);
  const miniTerminalVisible = useAtomValue(miniTerminalVisibleAtom);
  const openMiniTerminal = useSetAtom(openMiniTerminalAtom);
  const closeMiniTerminal = useSetAtom(closeMiniTerminalAtom);
  const setMiniTerminalHostMounted = useSetAtom(miniTerminalHostMountedAtom);

  // Claimed sessions are only suppressed in the Workstation pane while this
  // trail — the panel's only host — is actually mounted.
  useEffect(() => {
    setMiniTerminalHostMounted(true);
    return () => setMiniTerminalHostMounted(false);
  }, [setMiniTerminalHostMounted]);

  /**
   * Show the docked terminal. The terminal carries its own width, so the
   * trail above it keeps whatever width the user gave it — only the column
   * grows, and only when the terminal is the wider of the two.
   */
  const showMiniTerminal = useCallback(
    (sessionId: string | null) => {
      openMiniTerminal(sessionId);
    },
    [openMiniTerminal]
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

  /**
   * Terminal rows stay in the chat pane now: the session is claimed by the
   * trail's docked terminal instead of navigating to the Workstation.
   */
  const openTerminalSession = useCallback(
    (sessionId: string) => {
      showMiniTerminal(sessionId);
    },
    [showMiniTerminal]
  );

  const toggleMiniTerminal = useCallback(() => {
    if (miniTerminalVisible) {
      closeMiniTerminal();
      return;
    }
    showMiniTerminal(null);
  }, [closeMiniTerminal, miniTerminalVisible, showMiniTerminal]);

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
      // Terminal / Files / Browser rows are parked in the expanded list:
      // each of them left the focused chat for the Workstation, which is the
      // opposite of what the trail is for. The terminal now stays in the
      // pane — the header's terminal control and the trail's native
      // right-click menu open `WorkstationTrailTerminal` instead.
    ],
    [
      t,
      reviewAdditions,
      reviewDeletions,
      branchCompareUrl,
      branchPullRequest,
      branchPullRequestStatus,
    ]
  );

  /**
   * Collapsed rail keeps the original icon set. The parked rows are only
   * parked from the labelled list: in the 44px column these are pure icon
   * shortcuts with nothing to replace them — the docked terminal cannot open
   * in a column that narrow either.
   */
  const collapsedWorkspaceItems = useMemo<FocusedChatRailItem[]>(
    () => [
      ...workspaceItems,
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
      browserTab,
      openWorkstationHost,
      openWorkstationTab,
      requestNewBrowserSession,
      t,
      workspaceItems,
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

  // The collapsed 44px track has no room for the terminal panel.
  const showTrailTerminal = miniTerminalVisible && !collapsed;

  const handleTrailContextMenu = useWorkstationTrailMenu({
    width,
    minWidth,
    onWidthChange: applyWidth,
    onSetMinimum: setCurrentWidthAsMinimum,
    onRestoreDefault: restoreDefaultWidth,
    miniTerminalVisible,
    onOpenMiniTerminal: () => showMiniTerminal(null),
    onHideMiniTerminal: closeMiniTerminal,
  });
  const toggleGroup = useCallback((groupKey: string) => {
    setCollapsedGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) {
        next.delete(groupKey);
      } else {
        next.add(groupKey);
      }
      return next;
    });
  }, []);

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
      {/* Expanded column is continuously resizable (drag its leading edge, or
          right-click the trail for the native width menu); the collapsed
          column stays the fixed 44px button-controlled rail. */}
      <div
        data-workstation-pane-control
        data-workstation-trail-track
        className={`relative flex h-full shrink-0 flex-col items-start ${
          isResizing
            ? ""
            : "transition-[width] duration-200 ease-out motion-reduce:transition-none"
        } ${resolveFocusedChatWorkstationRailTrackClass(collapsed)}`}
        style={{
          ...resolveFocusedChatWorkstationRailInsetStyle(topInset),
          ...resolveTrailWidthVariables(width, {
            collapsed,
            terminalShown: showTrailTerminal,
          }),
        }}
      >
        {/* Trail + terminal, grouped so the resize edge spans exactly them
            and stops where they stop — the minimap track below is not part
            of the resizable surface. */}
        {/* The trail's own `max-h-full` is inert here — it resolves against
            this group, whose height is content-driven — so the group carries
            the cap instead: `max-h-full` against the full-height column plus
            `min-h-0` so it can actually shrink into it. Without both, a long
            trail outgrows the column and starves the minimap track below.
            No `overflow-hidden`: it would clip the resize edge's hit area,
            which reaches 6px past this box. */}
        <div className="relative hidden max-h-full min-h-0 w-full flex-col @[1100px]/focusedchat:flex">
          {!collapsed ? (
            <div className="absolute inset-y-0 left-0 z-30 flex">
              <VerticalResizeHandle
                className="h-full"
                isResizing={isResizing}
                onMouseDown={handleResizeMouseDown}
                onContextMenu={handleTrailContextMenu}
                tooltipLabel={t("common:git.rail.resizeTrail")}
                variant="transparent"
              />
            </div>
          ) : null}
          <WorkstationTrailSurface
            as="aside"
            aria-label={environmentLabel}
            // Right-click anywhere on the trail opens the same native width
            // menu as its resize edge — the edge alone is a 13px target.
            onContextMenu={handleTrailContextMenu}
            // `min-h-0` unconditionally: inside the capped group the trail
            // has to be able to shrink past its content height, whether what
            // it would push out is the terminal or the minimap track.
            className={`group/workstation-trail ml-auto flex min-h-0 ${WORKSTATION_TRAIL_WIDTH.surfaceResponsiveClass}`}
          >
            <WorkstationTrailHeader
              title={environmentLabel}
              collapsed={collapsed}
              titleActions={
                !collapsed && hasSessionEnvironment ? (
                  <WorkstationGroupToggle
                    collapseLabel={t("common:actions.collapse")}
                    collapsed={collapsedGroupKeys.has("session")}
                    expandLabel={t("common:actions.expand")}
                    groupKey="session"
                    onToggle={() => toggleGroup("session")}
                  />
                ) : null
              }
              actions={
                <div className="flex items-center">
                  {!collapsed ? (
                    <WorkstationTrailIconButton
                      onClick={toggleMiniTerminal}
                      aria-label={t(
                        miniTerminalVisible
                          ? "common:git.rail.hideMiniTerminal"
                          : "common:git.rail.openMiniTerminal"
                      )}
                      aria-pressed={miniTerminalVisible}
                      title={t(
                        miniTerminalVisible
                          ? "common:git.rail.hideMiniTerminal"
                          : "common:git.rail.openMiniTerminal"
                      )}
                      className={miniTerminalVisible ? "bg-fill-2" : ""}
                    >
                      <HugeiconsIcon
                        icon={SquareTerminalIcon}
                        data-icon="square-terminal"
                        size={14}
                        strokeWidth={1.75}
                      />
                    </WorkstationTrailIconButton>
                  ) : null}
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
                </div>
              }
            />
            {collapsed ? (
              <div className="flex flex-col items-center gap-2">
                {collapsedWorkspaceItems.map((item) => {
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
                <WorkstationSections
                  collapseGroupLabel={t("common:actions.collapse")}
                  collapsedGroupKeys={collapsedGroupKeys}
                  expandGroupLabel={t("common:actions.expand")}
                  onToggleGroup={toggleGroup}
                  sections={sections}
                />
              </WorkstationTrailBody>
            )}
          </WorkstationTrailSurface>
          {showTrailTerminal ? <WorkstationTrailTerminal /> : null}
        </div>
        <div
          ref={conversationMinimapHostRef}
          data-focused-chat-conversation-minimap-host
          className={FOCUSED_CHAT_WORKSTATION_MINIMAP_HOST_CLASS}
        />
      </div>
    </>
  );
}
