import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import {
  CHAT_BUBBLE_WIDTH_TOKENS,
  ChatBubbleAvatar,
  ChatBubbleHeader,
  ChatBubbleLayout,
} from "@src/components/ChatBubble";
import { TaskListCard } from "@src/engines/ChatPanel/blocks/ToolCallBlock/cards/TaskUpdateCard";
import { parseAgentMessageCard } from "@src/engines/ChatPanel/blocks/ToolCallBlock/helpers";
import {
  OrgSendMessageBlock,
  OrgTaskAdapter,
} from "@src/engines/ChatPanel/rendering/adapters";
import {
  inferStatusFromResult,
  mapStatus,
  normalizeEventProps,
} from "@src/engines/SessionCore/rendering/props/propsNormalizer";
import {
  formatSmartDateTime,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

import {
  buildTaskListCard,
  isOrgTaskEvent,
  resolveOrgTaskTitle,
  resolveRecipientLabel,
} from "./AgentEventBubbles/model";
import { useCommunicationAgentIdentity } from "./communicationAgentIdentity";
import type { MessageEntry } from "./types";

export { isOrgTaskEvent };

const EMPTY_EVENT_PAYLOAD: Record<string, unknown> = {};

interface FramedProps {
  message: MessageEntry;
  onClick?: () => void;
}

const Framed: React.FC<
  FramedProps & {
    senderName: string;
    icon: React.ReactNode;
    children: React.ReactNode;
  }
> = ({ message, senderName, icon, onClick, children }) => {
  const { t, i18n } = useTranslation(["common", "projects"]);
  return (
    <ChatBubbleLayout
      align="left"
      onClick={onClick}
      interactive={false}
      className={CHAT_BUBBLE_WIDTH_TOKENS.row}
      avatar={<ChatBubbleAvatar className="h-8 w-8 bg-fill-2" icon={icon} />}
    >
      <ChatBubbleHeader
        senderName={senderName}
        timestamp={formatSmartDateTime(message.timestamp, {
          yesterdayLabel: t("relativeDate.yesterday"),
          locale: toIntlLocaleTag(i18n.resolvedLanguage),
        })}
        align="left"
      />
      {children}
    </ChatBubbleLayout>
  );
};

interface OrgSendMessageBubbleProps extends FramedProps {
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
}

export const OrgSendMessageBubble: React.FC<OrgSendMessageBubbleProps> = memo(
  ({ message, onClick, orgMembers }) => {
    const { t } = useTranslation(["common", "sessions"]);
    const args = (message.event.args ?? EMPTY_EVENT_PAYLOAD) as Record<
      string,
      unknown
    >;
    const result = (message.event.result ?? EMPTY_EVENT_PAYLOAD) as Record<
      string,
      unknown
    >;
    const status = mapStatus(
      message.event.displayStatus || inferStatusFromResult(result)
    );
    const { rawAgentName, agentIcon } = useCommunicationAgentIdentity(
      message.event,
      orgMembers
    );
    const senderName = useMemo(() => {
      const card = parseAgentMessageCard(args, result);
      if (card.isBroadcast) {
        return t("simulator.replay.messages.bubble.senderTitle.sentBroadcast", {
          ns: "sessions",
          subject: rawAgentName,
          defaultValue: "{{subject}} sent a message to multiple agents",
        });
      }
      const recipient = resolveRecipientLabel(card.recipient, orgMembers);
      if (recipient) {
        return t("simulator.replay.messages.bubble.senderTitle.sentTo", {
          ns: "sessions",
          subject: rawAgentName,
          recipient,
          defaultValue: "{{subject}} sent a message to {{recipient}}",
        });
      }
      return t("simulator.replay.messages.bubble.senderTitle.sentMessage", {
        ns: "sessions",
        subject: rawAgentName,
        defaultValue: "{{subject}} sent a message",
      });
    }, [args, orgMembers, rawAgentName, result, t]);

    return (
      <Framed
        message={message}
        senderName={senderName}
        icon={agentIcon}
        onClick={onClick}
      >
        <OrgSendMessageBlock
          args={args}
          result={result}
          status={status}
          eventId={message.event.id}
          sessionId={message.event.sessionId}
          hideHeader
        />
      </Framed>
    );
  }
);
OrgSendMessageBubble.displayName = "OrgSendMessageBubble";

interface OrgTaskBubbleProps extends FramedProps {
  onNavigateToTodoList?: () => void;
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
}

export const OrgTaskEventBubble: React.FC<OrgTaskBubbleProps> = memo(
  ({ message, onClick, onNavigateToTodoList, orgMembers }) => {
    const { t } = useTranslation(["common", "sessions"]);
    const { rawAgentName, agentIcon, isAgentOrgBubble } =
      useCommunicationAgentIdentity(message.event, orgMembers);
    const senderName = useMemo(
      () =>
        resolveOrgTaskTitle(message.event, rawAgentName, t, isAgentOrgBubble),
      [isAgentOrgBubble, message.event, rawAgentName, t]
    );
    const taskListCard = buildTaskListCard(message.event);

    if (taskListCard) {
      return (
        <Framed
          message={message}
          senderName={senderName}
          icon={agentIcon}
          onClick={onClick}
        >
          <TaskListCard
            card={taskListCard}
            onNavigate={onNavigateToTodoList}
            hideHeader
          />
        </Framed>
      );
    }

    const props = normalizeEventProps(
      { event: message.event, context: "simulator" },
      message.event.functionName
    );
    if (!props) return null;
    return (
      <Framed
        message={message}
        senderName={senderName}
        icon={agentIcon}
        onClick={onClick}
      >
        <OrgTaskAdapter {...props} />
      </Framed>
    );
  }
);
OrgTaskEventBubble.displayName = "OrgTaskEventBubble";
