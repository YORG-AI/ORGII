/**
 * ChatPanelTabBar
 *
 * Inline tab-pill strip rendered inside the existing ChatPanelHeader row,
 * replacing the title/drag-spacer area for the unified chat-pane tabs. Uses
 * the exact same
 * primitives as the Workstation tab bar:
 *   - WorkStationTabPillSurface  (active/inactive pill surface)
 *   - TabPillCloseButton         (14px X close control)
 *   - TabLabelRowScrim           (gradient scrim behind close button)
 *   - TabBarTrailingIconButton   (+ button)
 *   - TAB_PAIR_SEPARATOR_SLOT_CLASS between pills
 *
 * Keyboard shortcuts live in useChatPanelTabShortcuts (mounted by ChatPanel
 * itself, not this strip, so they keep working while the strip is hidden):
 *   Cmd+W  — close active tab
 *   Cmd+]  — next tab    Cmd+[  — prev tab
 *   Cmd+N  — new session tab
 *   Cmd+T  — new terminal tab (via global "create-chat-tab" event)
 */
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  horizontalListSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue, useSetAtom } from "jotai";
import {
  Box,
  BriefcaseBusiness,
  CircleDot,
  Columns3,
  Gauge,
  GitPullRequest,
  Hash,
  Inbox,
  Info,
  LayoutGrid,
  ListChecks,
  ListTodo,
  Lock,
  MessageSquarePlus,
  Plus,
  Settings2,
  TerminalSquare,
} from "lucide-react";
import React, {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { STORY_SYNC_ADAPTER } from "@src/api/http/integrations/syncConnections";
import Dropdown from "@src/components/Dropdown";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import IntegrationIcon from "@src/components/IntegrationIcon";
import PrHoverCard, { type PrHoverCardData } from "@src/components/PrHoverCard";
import SessionHoverCard from "@src/components/SessionHoverCard";
import WorkItemHoverCard, {
  type WorkItemHoverCardData,
} from "@src/components/WorkItemHoverCard";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { TERMINAL_AGENT_STATUS } from "@src/engines/TerminalCore/types";
import { requestTeamInboxSessionHandoffAtom } from "@src/modules/MainApp/TeamInbox/store";
import { isGitHubIssueStatus } from "@src/modules/ProjectManager/WorkItems/workItemIdentity";
import { TabBarTrailingIconButton } from "@src/modules/WorkStation/shared/TabBar/components/TabBarTrailingIconButton";
import { TabLabelRowScrim } from "@src/modules/WorkStation/shared/TabBar/components/TabLabelRowScrim";
import { TabPillCloseButton } from "@src/modules/WorkStation/shared/TabBar/components/TabPillCloseButton";
import {
  WORK_STATION_TAB_PILL_DRAG_OVERLAY_CLASS,
  WorkStationTabPillSurface,
} from "@src/modules/WorkStation/shared/TabBar/components/WorkStationTabPillSurface";
import { TAB_PAIR_SEPARATOR_SLOT_CLASS } from "@src/modules/WorkStation/shared/TabBar/config";
import {
  SESSION_TAB_DROP_TARGET_HIGHLIGHT_CLASS,
  type SessionReferenceOpen,
  type SessionTabTransfer,
  dispatchSessionTabDragCancel,
  dispatchSessionTabDragEnd,
  dispatchSessionTabDragStart,
} from "@src/shared/dnd/sessionTabDrag";
import { useSessionTabDropTarget } from "@src/shared/dnd/useSessionTabDropTarget";
import { openTeamInboxInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabOpenAtoms";
import {
  type ChatPanelTab,
  activateChatPanelTabAtom,
  chatPanelTabsAtom,
  closeAndDestroyChatPanelTabAtom,
  closeOtherChatPanelTabsAtom,
  reorderChatPanelTabsAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { terminalSessionsAtom } from "@src/store/chatPanel/chatPanelTerminalAtom";
import { sessionByIdAtom } from "@src/store/session";
import { moveSessionTabAtom } from "@src/store/session/sessionTabPlacementAtom";
import {
  CHAT_PANEL_CREATE_TARGET,
  chatPanelCreateTargetAtom,
} from "@src/store/ui/chatPanelAtom";
import { WORK_MANAGEMENT_SECTION } from "@src/store/workstation";
import { isMacOS } from "@src/util/platform/tauri";

import ChatPanelTabContextMenu from "./ChatPanelTabContextMenu";
import { resolveChatPanelTabDisplayTitle } from "./chatPanelTabDisplay";
import SessionIdentityIcon from "./components/SessionIdentityIcon";
import {
  CHAT_PANEL_HEADER_DRAG_STYLE,
  CHAT_PANEL_HEADER_NO_DRAG_STYLE,
} from "./header";

export { useChatPanelTabShortcuts } from "./hooks/useChatPanelTabShortcuts";

// ─── Constants ────────────────────────────────────────────────────────────────

const TERMINAL_AGENT_STATUS_DOT_CLASS = {
  [TERMINAL_AGENT_STATUS.STARTING]: "bg-warning-6",
  [TERMINAL_AGENT_STATUS.RUNNING]: "bg-success-6",
  [TERMINAL_AGENT_STATUS.WAITING]: "bg-warning-6",
  [TERMINAL_AGENT_STATUS.DONE]: "bg-fill-4",
} as const;

// ─── TabPill ──────────────────────────────────────────────────────────────────

interface TabPillProps {
  tab: ChatPanelTab;
  isActive: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, id: string) => void;
}

interface TabPillHoverCardProps {
  tab: ChatPanelTab;
  children: React.ReactElement;
}

function getWorkItemHoverCardData(
  selection: NonNullable<ChatPanelTab["workItem"]>
): WorkItemHoverCardData {
  const { workItem } = selection;
  return {
    id: workItem.session_id,
    title: workItem.name,
    status: workItem.workItemStatus ?? workItem.status,
    priority: workItem.priority ?? "none",
    projectName: selection.projectName,
    orgName: selection.orgName ?? selection.sourceProject?.orgName,
    source: "local",
    assignee: workItem.assignee,
    labels: workItem.labels,
    createdAt: workItem.created_time,
    updatedAt: workItem.updated_time,
  };
}

function getPrHoverCardData(
  detail: NonNullable<ChatPanelTab["githubPr"]>
): PrHoverCardData {
  const isDraft = detail.prStatus === "draft";
  return {
    number: detail.prNumber,
    url: detail.prUrl,
    title: detail.prTitle,
    state: isDraft ? "open" : detail.prStatus,
    head_branch: detail.headBranch,
    base_branch: detail.baseBranch,
    draft: isDraft,
    additions: detail.additions,
    deletions: detail.deletions,
    updated_at: detail.updatedAt,
  };
}

/** Keep entity-preview selection in one place as new tab types are added. */
const TabPillHoverCard: React.FC<TabPillHoverCardProps> = ({
  tab,
  children,
}) => {
  if (tab.type === "session" && tab.sessionId) {
    return (
      <SessionHoverCard sessionId={tab.sessionId} position="bottom-start">
        {children}
      </SessionHoverCard>
    );
  }
  if (tab.type === "work-item" && tab.workItem) {
    return (
      <WorkItemHoverCard
        workItem={getWorkItemHoverCardData(tab.workItem)}
        position="bottom-start"
      >
        {children}
      </WorkItemHoverCard>
    );
  }
  if (tab.type === "github-pr" && tab.githubPr) {
    return (
      <PrHoverCard
        pr={getPrHoverCardData(tab.githubPr)}
        position="bottom-start"
      >
        {children}
      </PrHoverCard>
    );
  }
  return children;
};

const TabPill = memo(function TabPill({
  tab,
  isActive,
  onActivate,
  onClose,
  onContextMenu,
}: TabPillProps) {
  const { t } = useTranslation();
  const createTarget = useAtomValue(chatPanelCreateTargetAtom);
  const [hovered, setHovered] = useState(false);
  const showCloseSlot = hovered;
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: tab.id, disabled: tab.type !== "session" });

  // When this tab becomes active (e.g. via a sidebar click), reveal it in the
  // horizontally-scrollable tab strip. `nearest` only scrolls when off-screen.
  const pillRef = useRef<HTMLButtonElement | HTMLDivElement>(null);
  const setPillRef = useCallback(
    (node: HTMLButtonElement | HTMLDivElement | null) => {
      pillRef.current = node;
      setNodeRef(node);
    },
    [setNodeRef]
  );
  useEffect(() => {
    if (isActive) {
      pillRef.current?.scrollIntoView({
        behavior: "smooth",
        inline: "nearest",
        block: "nearest",
      });
    }
  }, [isActive]);

  // Read session data for icon + hover card (session tabs only)
  const session = useAtomValue(sessionByIdAtom(tab.sessionId ?? ""));
  const terminalSessions = useAtomValue(terminalSessionsAtom);
  const terminalSession =
    tab.type === "terminal"
      ? terminalSessions.find(
          (candidate) => candidate.id === tab.terminalSessionId
        )
      : undefined;
  const agentStatus = terminalSession?.agentStatus;

  const defaultDisplayTitle = resolveChatPanelTabDisplayTitle(tab, session, {
    newSession: t("sessions:chat.startPage.newSession.title"),
    runtime: t("sessions:chat.startPage.tabs.runtime"),
    organization: t("navigation:collaboration.manageOrg"),
    teamInbox: t("navigation:labels.inbox"),
    channelFallback: t("navigation:cloud.channels.title"),
    workManagement: {
      kanban: t("sessions:simulator.tabs.kanban"),
      work: t("navigation:labels.workItems"),
    },
    sessionFallback: t("chat.defaultTitle"),
  });
  const displayTitle =
    tab.type !== "start-page"
      ? defaultDisplayTitle
      : createTarget === CHAT_PANEL_CREATE_TARGET.PROJECT
        ? t("sessions:creator.createTarget.project")
        : createTarget === CHAT_PANEL_CREATE_TARGET.WORK_ITEM
          ? t("sessions:creator.createTarget.workItem")
          : createTarget === CHAT_PANEL_CREATE_TARGET.GITHUB_ISSUES_PROJECT
            ? t("projects:githubIssuesImport.createTarget")
            : createTarget === CHAT_PANEL_CREATE_TARGET.COLLAB_ORG
              ? t("navigation:collaboration.addOrg")
              : createTarget === CHAT_PANEL_CREATE_TARGET.MANAGE_AGENTS
                ? t("sessions:creator.createTarget.manageAgents")
                : defaultDisplayTitle;

  const iconColorClass = isActive ? "text-primary-6" : "text-text-2";
  const isGitHubIssueTab =
    tab.type === "work-item" &&
    isGitHubIssueStatus(
      tab.workItem?.workItem.workItemStatus ?? tab.workItem?.workItem.status
    );

  let icon: React.ReactNode;
  if (tab.type === "terminal") {
    icon = (
      <TerminalSquare
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "start-page") {
    if (createTarget === CHAT_PANEL_CREATE_TARGET.PROJECT) {
      icon = (
        <Box
          size={16}
          strokeWidth={1.75}
          className={`shrink-0 ${iconColorClass}`}
        />
      );
    } else if (createTarget === CHAT_PANEL_CREATE_TARGET.WORK_ITEM) {
      icon = (
        <ListChecks
          size={16}
          strokeWidth={1.75}
          className={`shrink-0 ${iconColorClass}`}
        />
      );
    } else if (
      createTarget === CHAT_PANEL_CREATE_TARGET.GITHUB_ISSUES_PROJECT
    ) {
      icon = (
        <IntegrationIcon
          type={STORY_SYNC_ADAPTER.GITHUB}
          size={16}
          className={`shrink-0 ${iconColorClass}`}
        />
      );
    } else {
      icon = (
        <LayoutGrid
          size={16}
          strokeWidth={1.75}
          className={`shrink-0 ${iconColorClass}`}
        />
      );
    }
  } else if (tab.type === "runtime") {
    icon = (
      <Gauge
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "team-inbox") {
    icon = (
      <Inbox
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "channel") {
    // Private cloud channels carry the same lock the sidebar row uses.
    const ChannelIcon =
      tab.channel?.scope === "cloud" && tab.channel.visibility === "private"
        ? Lock
        : Hash;
    icon = (
      <ChannelIcon
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "workspace") {
    icon = (
      <Info
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "organization") {
    icon = (
      <Settings2
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "work-management") {
    const WorkManagementIcon =
      tab.managementSection === WORK_MANAGEMENT_SECTION.KANBAN
        ? Columns3
        : ListTodo;
    icon = React.createElement(WorkManagementIcon, {
      size: 16,
      strokeWidth: 1.75,
      className: `shrink-0 ${iconColorClass}`,
    });
  } else if (tab.type === "github-issue") {
    icon = (
      <CircleDot
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "github-pr") {
    icon = (
      <GitPullRequest
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (
    tab.type === "project" &&
    tab.project?.projectSyncAdapterId === STORY_SYNC_ADAPTER.GITHUB
  ) {
    icon = (
      <IntegrationIcon
        type={STORY_SYNC_ADAPTER.GITHUB}
        size={16}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (isGitHubIssueTab) {
    icon = (
      <IntegrationIcon
        type={STORY_SYNC_ADAPTER.GITHUB}
        size={16}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "project") {
    icon = (
      <Box
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "work-item") {
    icon = (
      <ListChecks
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "session" && tab.sessionId) {
    icon = (
      <SessionIdentityIcon
        session={session}
        sessionId={tab.sessionId}
        isSelected={isActive}
      />
    );
  } else {
    icon = (
      <MessageSquarePlus
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  }

  const pill = (
    <WorkStationTabPillSurface
      ref={setPillRef}
      {...attributes}
      {...listeners}
      isActive={isActive}
      variant="session"
      role="tab"
      aria-selected={isActive}
      title={displayTitle}
      onClick={() => onActivate(tab.id)}
      onAuxClick={(evt) => {
        if (evt.button === 1) onClose(tab.id);
      }}
      onContextMenu={(event) => onContextMenu(event, tab.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        ...CHAT_PANEL_HEADER_NO_DRAG_STYLE,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.35 : 1,
      }}
    >
      <div className="flex shrink-0 items-center justify-center">{icon}</div>
      <div className="relative flex min-w-0 flex-1 items-center overflow-hidden">
        <span
          className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[13px] ${
            isActive ? "text-primary-6" : "text-text-2"
          }`}
        >
          {displayTitle}
        </span>
        {agentStatus && (
          <span
            aria-hidden="true"
            className={`ml-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${TERMINAL_AGENT_STATUS_DOT_CLASS[agentStatus]}`}
          />
        )}
        <TabLabelRowScrim visible={showCloseSlot} />
      </div>
      <TabPillCloseButton
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.id);
        }}
        title={t("actions.close")}
        showX={hovered}
        className={`grid place-items-center rounded text-text-3 transition-[opacity,colors,background-color] duration-150 ${SURFACE_TOKENS.hover} absolute right-1 top-1/2 z-10 h-5 w-5 -translate-y-1/2 hover:text-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-6 focus-visible:ring-offset-0 ${
          showCloseSlot
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        }`}
      />
    </WorkStationTabPillSurface>
  );

  return <TabPillHoverCard tab={tab}>{pill}</TabPillHoverCard>;
});

// ─── Plus-menu dropdown ───────────────────────────────────────────────────────

interface PlusMenuContentProps {
  onOpenLaunchpad: () => void;
  onOpenKanban: () => void;
  onOpenRuntime: () => void;
  onNewProject: () => void;
  onNewWorkItem: () => void;
  onClose: () => void;
}

export function PlusMenuContent({
  onOpenLaunchpad,
  onOpenKanban,
  onOpenRuntime,
  onNewProject,
  onNewWorkItem,
  onClose,
}: PlusMenuContentProps) {
  const { t } = useTranslation(["sessions", "navigation"]);
  const MOD = isMacOS() ? "⌘" : "Ctrl";

  // New session opens the singleton start page. It carries the ⌘N hint since
  // that shortcut (handled in ChatPanelTabBar) opens the same surface.
  const items = [
    {
      id: "launchpad",
      icon: <LayoutGrid size={HEADER_ICON_SIZE.sm} strokeWidth={1.8} />,
      label: t("sessions:chat.startPage.newSession.title"),
      hint: `${MOD}N`,
      onClick: onOpenLaunchpad,
    },
    {
      id: "work-management",
      icon: <Columns3 size={HEADER_ICON_SIZE.sm} strokeWidth={1.8} />,
      label: t("sessions:simulator.tabs.kanban"),
      onClick: onOpenKanban,
    },
    {
      id: "runtime",
      icon: <Gauge size={HEADER_ICON_SIZE.sm} strokeWidth={1.8} />,
      label: t("sessions:chat.startPage.tabs.runtime"),
      onClick: onOpenRuntime,
    },
    {
      id: "new-project",
      icon: <Box size={HEADER_ICON_SIZE.sm} strokeWidth={1.8} />,
      label: t("sessions:creator.createTarget.project"),
      onClick: onNewProject,
    },
    {
      id: "new-work-item",
      icon: <BriefcaseBusiness size={HEADER_ICON_SIZE.sm} strokeWidth={1.8} />,
      label: t("chat.startPage.newWorkItem.title"),
      onClick: onNewWorkItem,
    },
  ] as const;

  return (
    <div
      className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.wideMenuClass}`}
    >
      <div className={DROPDOWN_CLASSES.itemsColumn}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            className={`${DROPDOWN_CLASSES.menuActionItem} justify-between`}
            onClick={() => {
              onClose();
              item.onClick();
            }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2">
              {item.icon}
              <span className="truncate">{item.label}</span>
            </span>
            {"hint" in item && item.hint ? (
              <span className="ml-4 shrink-0 text-[11px] text-text-3">
                {item.hint}
              </span>
            ) : null}
          </button>
        ))}
      </div>
    </div>
  );
}

// ─── Exported + menu button (placed in header toolbar, left of ...) ───────────

export interface ChatPanelPlusMenuProps {
  onOpenLaunchpad: () => void;
  onOpenKanban: () => void;
  onOpenRuntime: () => void;
  onNewProject: () => void;
  onNewWorkItem: () => void;
}

export function ChatPanelPlusMenu({
  onOpenLaunchpad,
  onOpenKanban,
  onOpenRuntime,
  onNewProject,
  onNewWorkItem,
}: ChatPanelPlusMenuProps): React.ReactNode {
  const { t } = useTranslation("sessions");
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const plusLabel = t("chat.tabs.newTab", "New tab");

  return (
    <Dropdown
      droplist={
        <PlusMenuContent
          onOpenLaunchpad={onOpenLaunchpad}
          onOpenKanban={onOpenKanban}
          onOpenRuntime={onOpenRuntime}
          onNewProject={onNewProject}
          onNewWorkItem={onNewWorkItem}
          onClose={closeMenu}
        />
      }
      position="bottom-end"
      trigger="click"
      popupVisible={menuOpen}
      onVisibleChange={setMenuOpen}
      getPopupContainer={() => document.body}
      avoidViewportOverflow
    >
      <span
        className="inline-flex shrink-0"
        style={CHAT_PANEL_HEADER_NO_DRAG_STYLE}
      >
        <TabBarTrailingIconButton
          title={plusLabel}
          active={menuOpen}
          tooltipDisabled
          nativeTitle={false}
        >
          <Plus size={HEADER_ICON_SIZE.md} strokeWidth={2} />
        </TabBarTrailingIconButton>
      </span>
    </Dropdown>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export function ChatPanelTabBar(): React.ReactNode {
  const { t } = useTranslation();
  const state = useAtomValue(chatPanelTabsAtom);
  const activateTab = useSetAtom(activateChatPanelTabAtom);
  const closeTab = useSetAtom(closeAndDestroyChatPanelTabAtom);
  const closeOtherTabs = useSetAtom(closeOtherChatPanelTabsAtom);
  const reorderTabs = useSetAtom(reorderChatPanelTabsAtom);
  const moveSessionTab = useSetAtom(moveSessionTabAtom);
  const openTeamInbox = useSetAtom(openTeamInboxInChatPanelTabAtom);
  const requestSessionHandoff = useSetAtom(requestTeamInboxSessionHandoffAtom);
  const barRef = useRef<HTMLDivElement>(null);
  const pointerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const pointerTrackerRef = useRef<((event: PointerEvent) => void) | null>(
    null
  );
  const [draggingTabId, setDraggingTabId] = useState<string | null>(null);
  const [contextMenuTabId, setContextMenuTabId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );
  const tabIds = state.tabs.map((tab) => tab.id);
  const draggingTab = state.tabs.find((tab) => tab.id === draggingTabId);
  const contextMenuTab = state.tabs.find((tab) => tab.id === contextMenuTabId);

  const handleSessionTabDrop = useCallback(
    (transfer: SessionTabTransfer) => moveSessionTab(transfer),
    [moveSessionTab]
  );
  const isSessionDragOver = useSessionTabDropTarget({
    target: "chat-panel",
    containerRef: barRef,
    onDrop: handleSessionTabDrop,
  });

  const removePointerTracker = useCallback(() => {
    if (!pointerTrackerRef.current) return;
    window.removeEventListener("pointermove", pointerTrackerRef.current);
    pointerTrackerRef.current = null;
  }, []);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const tabId = String(event.active.id);
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      if (tab?.type !== "session" || !tab.sessionId) return;
      setDraggingTabId(tabId);

      const activatorEvent = event.activatorEvent;
      if (
        "clientX" in activatorEvent &&
        "clientY" in activatorEvent &&
        typeof activatorEvent.clientX === "number" &&
        typeof activatorEvent.clientY === "number"
      ) {
        pointerPositionRef.current = {
          x: activatorEvent.clientX,
          y: activatorEvent.clientY,
        };
      }
      const trackPointer = (pointerEvent: PointerEvent) => {
        pointerPositionRef.current = {
          x: pointerEvent.clientX,
          y: pointerEvent.clientY,
        };
      };
      pointerTrackerRef.current = trackPointer;
      window.addEventListener("pointermove", trackPointer, { passive: true });
      dispatchSessionTabDragStart({
        source: "chat-panel",
        sourceTabId: tab.id,
        sessionId: tab.sessionId,
        title: tab.title,
      });
    },
    [state.tabs]
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const tabId = String(event.active.id);
      const tab = state.tabs.find((candidate) => candidate.id === tabId);
      const pointer = pointerPositionRef.current;
      removePointerTracker();
      pointerPositionRef.current = null;
      setDraggingTabId(null);

      let movedToWorkstation = false;
      if (tab?.type === "session" && tab.sessionId && pointer) {
        movedToWorkstation = dispatchSessionTabDragEnd(
          {
            source: "chat-panel",
            sourceTabId: tab.id,
            sessionId: tab.sessionId,
            title: tab.title,
          },
          pointer.x,
          pointer.y
        );
      } else {
        dispatchSessionTabDragCancel();
      }

      if (
        !movedToWorkstation &&
        event.over &&
        event.over.id !== event.active.id
      ) {
        const startIndex = state.tabs.findIndex(
          (candidate) => candidate.id === event.active.id
        );
        const endIndex = state.tabs.findIndex(
          (candidate) => candidate.id === event.over?.id
        );
        reorderTabs({ startIndex, endIndex });
      }
    },
    [removePointerTracker, reorderTabs, state.tabs]
  );

  const handleDragCancel = useCallback(() => {
    removePointerTracker();
    pointerPositionRef.current = null;
    setDraggingTabId(null);
    dispatchSessionTabDragCancel();
  }, [removePointerTracker]);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent, tabId: string) => {
      event.preventDefault();
      event.stopPropagation();
      setContextMenuTabId(tabId);
    },
    []
  );
  const handleDismissContextMenu = useCallback(
    () => setContextMenuTabId(null),
    []
  );
  const handleCreateWorkItem = useCallback(
    (reference: SessionReferenceOpen) => {
      requestSessionHandoff(reference);
      openTeamInbox(t("navigation:labels.inbox"));
    },
    [openTeamInbox, requestSessionHandoff, t]
  );

  // Inline strip — no outer wrapper, fills the flex row in the header
  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <SortableContext
          items={tabIds}
          strategy={horizontalListSortingStrategy}
        >
          <div
            ref={barRef}
            className="relative flex min-w-0 flex-1 items-center overflow-x-auto overflow-y-hidden scrollbar-hide"
            data-session-tab-drop-target="chat-panel"
            data-tauri-drag-region
            style={CHAT_PANEL_HEADER_DRAG_STYLE}
          >
            {isSessionDragOver ? (
              <div
                className={`${SESSION_TAB_DROP_TARGET_HIGHLIGHT_CLASS} inset-0`}
                aria-hidden
              />
            ) : null}
            <span
              className={`${TAB_PAIR_SEPARATOR_SLOT_CLASS} bg-transparent`}
              aria-hidden
              data-tauri-drag-region
              style={CHAT_PANEL_HEADER_DRAG_STYLE}
            />

            {state.tabs.map((tab, i) => {
              const next = state.tabs[i + 1];
              const isActive = tab.id === state.activeTabId;
              const nextIsActive = next?.id === state.activeTabId;
              const separatorVisible = !!next && !isActive && !nextIsActive;

              return (
                <Fragment key={tab.id}>
                  <TabPill
                    tab={tab}
                    isActive={isActive}
                    onActivate={activateTab}
                    onClose={closeTab}
                    onContextMenu={handleContextMenu}
                  />
                  {next && (
                    <span
                      className={`${TAB_PAIR_SEPARATOR_SLOT_CLASS} ${
                        separatorVisible ? "bg-border-2" : "bg-transparent"
                      }`}
                      aria-hidden
                      data-tauri-drag-region
                      style={CHAT_PANEL_HEADER_DRAG_STYLE}
                    />
                  )}
                </Fragment>
              );
            })}
          </div>
        </SortableContext>
        {typeof document !== "undefined"
          ? createPortal(
              <DragOverlay dropAnimation={null}>
                {draggingTab ? (
                  <div className={WORK_STATION_TAB_PILL_DRAG_OVERLAY_CLASS}>
                    <MessageSquarePlus size={16} strokeWidth={1.75} />
                    <span className="truncate text-primary-6">
                      {draggingTab.title}
                    </span>
                  </div>
                ) : null}
              </DragOverlay>,
              document.body
            )
          : null}
      </DndContext>
      {contextMenuTabId ? (
        <ChatPanelTabContextMenu
          key={contextMenuTabId}
          tabId={contextMenuTabId}
          sessionReference={
            contextMenuTab?.type === "session" && contextMenuTab.sessionId
              ? {
                  sessionId: contextMenuTab.sessionId,
                  title: contextMenuTab.title,
                }
              : undefined
          }
          onCreateWorkItem={handleCreateWorkItem}
          onCloseTab={closeTab}
          onCloseOtherTabs={closeOtherTabs}
          onDismiss={handleDismissContextMenu}
        />
      ) : null}
    </>
  );
}
