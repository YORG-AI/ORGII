/**
 * TabPill — one pill in the chat-panel tab strip.
 *
 * Uses the same primitives as the Workstation tab bar
 * (TabPillSurface / TabPillCloseButton / TabLabelRowScrim) and
 * resolves its own icon and title from the tab type plus store data.
 */
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue } from "jotai";
import {
  Box,
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
  Settings2,
  TerminalSquare,
} from "lucide-react";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { STORY_SYNC_ADAPTER } from "@src/api/http/integrations/syncConnections";
import IntegrationIcon from "@src/components/IntegrationIcon";
import { TabLabelRowScrim } from "@src/components/TabPill/TabLabelRowScrim";
import { TabPillCloseButton } from "@src/components/TabPill/TabPillCloseButton";
import { TabPillSurface } from "@src/components/TabPill/TabPillSurface";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { TERMINAL_AGENT_STATUS } from "@src/engines/TerminalCore/types";
import { isGitHubIssueStatus } from "@src/modules/ProjectManager/WorkItems/workItemIdentity";
import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";
import { terminalSessionsAtom } from "@src/store/chatPanel/chatPanelTerminalAtom";
import { sessionByIdAtom } from "@src/store/session";
import {
  CHAT_PANEL_CREATE_TARGET,
  chatPanelCreateTargetAtom,
} from "@src/store/ui/chatPanelAtom";
import { WORK_MANAGEMENT_SECTION } from "@src/store/workstation";

import { resolveChatPanelTabDisplayTitle } from "../chatPanelTabDisplay";
import SessionIdentityIcon from "../components/SessionIdentityIcon";
import { CHAT_PANEL_HEADER_NO_DRAG_STYLE } from "../header";
import { TabPillHoverCard } from "./TabPillHoverCard";

// ─── Constants ────────────────────────────────────────────────────────────────

const TERMINAL_AGENT_STATUS_DOT_CLASS = {
  [TERMINAL_AGENT_STATUS.STARTING]: "bg-warning-6",
  [TERMINAL_AGENT_STATUS.RUNNING]: "bg-success-6",
  [TERMINAL_AGENT_STATUS.WAITING]: "bg-warning-6",
  [TERMINAL_AGENT_STATUS.DONE]: "bg-fill-4",
} as const;

interface TabPillProps {
  tab: ChatPanelTab;
  isActive: boolean;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onContextMenu: (event: React.MouseEvent, id: string) => void;
}

export const TabPill = memo(function TabPill({
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

  const iconColorClass = isActive ? "text-text-1" : "text-text-2";
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
    <TabPillSurface
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
            isActive ? "text-text-1" : "text-text-2"
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
    </TabPillSurface>
  );

  return <TabPillHoverCard tab={tab}>{pill}</TabPillHoverCard>;
});
