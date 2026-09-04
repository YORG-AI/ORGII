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
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { STORY_SYNC_ADAPTER } from "@src/api/http/integrations/syncConnections";
import AnyIcon from "@src/components/AnyIcon";
import IntegrationIcon from "@src/components/IntegrationIcon";
import { TabLabelRowScrim } from "@src/components/TabPill/TabLabelRowScrim";
import { TabPillCloseButton } from "@src/components/TabPill/TabPillCloseButton";
import { TabPillSurface } from "@src/components/TabPill/TabPillSurface";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { TERMINAL_AGENT_STATUS } from "@src/engines/TerminalCore/types";
import {
  CircleDotIcon,
  DeliveryBox01Icon,
  GaugeIcon,
  GitPullRequestIcon,
  HashtagIcon,
  HugeiconsIcon,
  InboxIcon,
  InformationCircleIcon,
  KanbanIcon,
  ListChecksIcon,
  ListTodoIcon,
  LockIcon,
  MessageAdd01Icon,
  MessageAdd02Icon,
  PencilEdit02Icon,
  Settings02Icon,
  SquareTerminalIcon,
} from "@src/icons";
import { isGitHubIssueStatus } from "@src/modules/ProjectManager/WorkItems/workItemIdentity";
import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";
import { terminalSessionsAtom } from "@src/store/chatPanel/chatPanelTerminalAtom";
import { sessionByIdAtom } from "@src/store/session";
import {
  CHAT_PANEL_CREATE_TARGET,
  chatPanelCreateTargetAtom,
} from "@src/store/ui/chatPanelAtom";
import { WORK_MANAGEMENT_SECTION } from "@src/store/workstation";

import SessionIdentityIcon from "../components/SessionIdentityIcon";
import { CHAT_PANEL_HEADER_NO_DRAG_STYLE } from "../header";
import { useChatPanelTabDisplayTitle } from "../hooks/useChatPanelTabDisplayTitle";
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

  const displayTitle = useChatPanelTabDisplayTitle(tab);

  const iconColorClass = isActive ? "text-text-1" : "text-text-2";
  const isGitHubIssueTab =
    tab.type === "work-item" &&
    isGitHubIssueStatus(
      tab.workItem?.workItem.workItemStatus ?? tab.workItem?.workItem.status
    );

  let icon: React.ReactNode;
  if (tab.type === "terminal") {
    icon = (
      <HugeiconsIcon
        icon={SquareTerminalIcon}
        data-icon="terminal-square"
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "start-page") {
    if (createTarget === CHAT_PANEL_CREATE_TARGET.PROJECT) {
      icon = (
        <HugeiconsIcon
          icon={DeliveryBox01Icon}
          data-icon="box"
          size={16}
          strokeWidth={1.75}
          className={`shrink-0 ${iconColorClass}`}
        />
      );
    } else if (createTarget === CHAT_PANEL_CREATE_TARGET.WORK_ITEM) {
      icon = (
        <HugeiconsIcon
          icon={PencilEdit02Icon}
          data-icon="square-pen"
          size={16}
          strokeWidth={1.75}
          className={`shrink-0 ${iconColorClass}`}
        />
      );
    } else {
      icon = (
        <HugeiconsIcon
          icon={MessageAdd02Icon}
          data-icon="message-add"
          size={16}
          strokeWidth={1.75}
          className={`shrink-0 ${iconColorClass}`}
        />
      );
    }
  } else if (tab.type === "runtime") {
    icon = (
      <HugeiconsIcon
        icon={GaugeIcon}
        data-icon="gauge"
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "team-inbox") {
    icon = (
      <HugeiconsIcon
        icon={InboxIcon}
        data-icon="inbox"
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "channel") {
    // Private cloud channels carry the same lock the sidebar row uses.
    const ChannelIcon =
      tab.channel?.scope === "cloud" && tab.channel.visibility === "private"
        ? LockIcon
        : HashtagIcon;
    icon = (
      <AnyIcon
        icon={ChannelIcon}
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "workspace") {
    icon = (
      <HugeiconsIcon
        icon={InformationCircleIcon}
        data-icon="info"
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "organization") {
    icon = (
      <HugeiconsIcon
        icon={Settings02Icon}
        data-icon="settings-2"
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "work-management") {
    const WorkManagementIcon =
      tab.managementSection === WORK_MANAGEMENT_SECTION.KANBAN
        ? KanbanIcon
        : ListTodoIcon;
    icon = (
      <HugeiconsIcon
        icon={WorkManagementIcon}
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "github-issue") {
    icon = (
      <HugeiconsIcon
        icon={CircleDotIcon}
        data-icon="circle-dot"
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "github-pr") {
    icon = (
      <HugeiconsIcon
        icon={GitPullRequestIcon}
        data-icon="git-pull-request"
        size={16}
        strokeWidth={1.75}
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
      <HugeiconsIcon
        icon={DeliveryBox01Icon}
        data-icon="box"
        size={16}
        strokeWidth={1.75}
        className={`shrink-0 ${iconColorClass}`}
      />
    );
  } else if (tab.type === "work-item") {
    icon = (
      <HugeiconsIcon
        icon={ListChecksIcon}
        data-icon="list-checks"
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
      <HugeiconsIcon
        icon={MessageAdd01Icon}
        data-icon="message-square-plus"
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
      data-tab-id={tab.id}
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
          className={`min-w-0 flex-1 overflow-hidden text-[13px] text-ellipsis whitespace-nowrap ${
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
        className={`grid place-items-center rounded text-text-3 transition-[opacity,colors,background-color] duration-150 ${SURFACE_TOKENS.hover} absolute top-1/2 right-1 z-10 h-5 w-5 -translate-y-1/2 hover:text-text-1 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-6 focus-visible:ring-offset-0 ${
          showCloseSlot
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0"
        }`}
      />
    </TabPillSurface>
  );

  return <TabPillHoverCard tab={tab}>{pill}</TabPillHoverCard>;
});
