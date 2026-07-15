/**
 * AgentEventBubbles
 *
 * Simulator-side bubble wrappers that reuse the chat-panel renderers
 * (`OrgTaskAdapter`, `OrgSendMessageBlock`) so the Messages tab and the
 * Chat Panel share one set of card components. The bubble itself
 * (avatar + sender header) is the simulator's own framing — only the
 * body content delegates to the chat-panel card.
 *
 * Sender header rules (simulator only)
 * ------------------------------------
 * The outer `Framed` bubble owns the entire title row: the inner chat-
 * panel block runs in its header-less variant. To keep the title
 * informative we replace the static "Agent" label with a verb phrase
 * like "Planner updated task" / "Planner sent a message to Coordinator"
 * / "Planner viewed task list", resolved from:
 *   - the subagent name (`event.sessionId` → org-run member name; falls
 *     back to "Agent" if the run roster hasn't loaded or doesn't include
 *     the sender — e.g. the outer coordinator session itself);
 *   - the event action (`extracted.action` or `functionName`);
 *   - the recipient (`AgentMessageCardData.recipient`).
 *
 * Routes:
 *   - org_send_message → OrgSendMessageBubble → chat-panel `OrgSendMessageBlock`
 *   - task_create / task_update / task_list / task_get →
 *       OrgTaskEventBubble → chat-panel `OrgTaskAdapter`
 *
 * The `manage_todo` tool keeps using `TodoBubble` (chat-panel `TodoBlock`)
 * because the simulator's todo view aggregates state across many events.
 */
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
import type { TaskListCardData } from "@src/engines/ChatPanel/blocks/ToolCallBlock/types";
import {
  OrgSendMessageBlock,
  OrgTaskAdapter,
  orgTaskItemToCardData,
} from "@src/engines/ChatPanel/rendering/adapters";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { resolveOrgTaskOperationOutcome } from "@src/engines/SessionCore/rendering/orgTaskOutcome";
import {
  inferStatusFromResult,
  mapStatus,
  normalizeEventProps,
} from "@src/engines/SessionCore/rendering/props/propsNormalizer";
import {
  formatSmartDateTime,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";
import { prettifyMemberName } from "@src/util/data/formatters/memberName";

import { useCommunicationAgentIdentity } from "./communicationAgentIdentity";
import type { MessageEntry } from "./types";

const EMPTY_EVENT_PAYLOAD: Record<string, unknown> = {};

/**
 * Function names whose payloads carry an `extracted.kind === "orgTask"`
 * (or otherwise belong to the Agent Team task family). Keep the routing
 * decision here so both `MessageBubbleRenderer` and downstream filters
 * can share the same predicate.
 */
const ORG_TASK_FUNCTION_NAMES = new Set([
  "task_create",
  "task_update",
  "task_list",
  "task_get",
]);

export function isOrgTaskEvent(event: SessionEvent): boolean {
  if (event.extracted?.kind === "orgTask") return true;
  return ORG_TASK_FUNCTION_NAMES.has(event.functionName);
}

/**
 * Resolve a subagent display name from `event.sessionId` against the
 * active org-run roster. Falls back to the generic agent label when:
 *   - the roster hasn't loaded yet (poll race);
 *   - the event came from the outer coordinator session itself (i.e. the
 *     sessionId is the session we're already attached to);
 *   - the session belongs to a member that left the run.
 */
/**
 * Resolve a display name for a recipient `memberId` (e.g. "coordinator").
 * Falls back to a prettified form of the raw id when the roster lookup
 * misses — this keeps broadcasts and unknown recipients readable without
 * crashing the title row.
 */
function resolveRecipientLabel(
  rawRecipient: string,
  orgMembers: ReadonlyArray<AgentOrgRunMemberView> | undefined
): string {
  const trimmed = rawRecipient.trim();
  if (!trimmed) return "";
  const match = orgMembers?.find(
    (member) => member.memberId === trimmed || member.name === trimmed
  );
  if (match?.name?.trim()) return match.name.trim();
  return prettifyMemberName(trimmed) || trimmed;
}

interface FramedProps {
  message: MessageEntry;
  onClick?: () => void;
}

/**
 * Local copy of `AgentFramedBubble` from `ChatBubble.tsx` — the framing
 * is small enough to inline here and avoid an import cycle. Both files
 * use the same `ChatBubbleLayout` + `ChatBubbleAvatar` + header pattern,
 * so the visual result is identical. Accepts an explicit `senderName`
 * (e.g. a verb phrase like "Planner updated task") so callers can
 * specialize the title row per event type.
 */
const Framed: React.FC<{
  message: MessageEntry;
  senderName: string;
  icon: React.ReactNode;
  onClick?: () => void;
  children: React.ReactNode;
}> = ({ message, senderName, icon, onClick, children }) => {
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
  /** Org-run roster used to resolve sender/recipient display names. */
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
      const subject = rawAgentName;
      const card = parseAgentMessageCard(args, result);
      if (card.isBroadcast) {
        return t("simulator.replay.messages.bubble.senderTitle.sentBroadcast", {
          ns: "sessions",
          subject,
          defaultValue: "{{subject}} sent a message to multiple agents",
        });
      }
      const recipientLabel = resolveRecipientLabel(card.recipient, orgMembers);
      if (recipientLabel) {
        return t("simulator.replay.messages.bubble.senderTitle.sentTo", {
          ns: "sessions",
          subject,
          recipient: recipientLabel,
          defaultValue: "{{subject}} sent a message to {{recipient}}",
        });
      }
      return t("simulator.replay.messages.bubble.senderTitle.sentMessage", {
        ns: "sessions",
        subject,
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
  /**
   * Invoked when the user clicks the navigate arrow on a `task_list` /
   * `task_get` card header. Wired by the parent to switch the
   * Communication view to the Todo Kanban tab. Omit for `task_create` /
   * `task_update` cards — the adapter handles those without navigation.
   */
  onNavigateToTodoList?: () => void;
  /** Org-run roster used to resolve the subagent display name. */
  orgMembers?: ReadonlyArray<AgentOrgRunMemberView>;
}

function resolveOrgTaskTitle(
  event: SessionEvent,
  subject: string,
  t: ReturnType<typeof useTranslation>["t"],
  isAgentOrgBubble: boolean
): string {
  const action =
    event.extracted?.kind === "orgTask"
      ? event.extracted.action
      : (() => {
          // Fall back to function name when extracted payload is missing
          // (e.g. an older replay frame): map task_* → coarse action.
          if (event.functionName === "task_create") return "create";
          if (event.functionName === "task_update") return "update";
          if (event.functionName === "task_get") return "get";
          if (event.functionName === "task_list") return "list";
          return null;
        })();

  if (event.extracted?.kind === "orgTask") {
    const outcome = resolveOrgTaskOperationOutcome(
      event.extracted,
      event.result,
      event.displayStatus
    );
    if (outcome !== "succeeded") {
      const createKey =
        outcome === "pending"
          ? "taskCreateRunning"
          : outcome === "rejected"
            ? "taskCreateRejected"
            : "taskCreateFailed";
      const genericKey =
        outcome === "pending"
          ? "taskOperationRunning"
          : outcome === "rejected"
            ? "taskOperationRejected"
            : "taskOperationFailed";
      return t(
        `simulator.replay.messages.bubble.senderTitle.${action === "create" ? createKey : genericKey}`,
        {
          ns: "sessions",
          subject,
          defaultValue:
            action === "create"
              ? outcome === "pending"
                ? "{{subject}} is creating a task"
                : outcome === "rejected"
                  ? "{{subject}}'s task creation needs correction"
                  : "{{subject}} couldn't create task"
              : outcome === "pending"
                ? "{{subject}} is running a task operation"
                : outcome === "rejected"
                  ? "{{subject}}'s task operation needs correction"
                  : "{{subject}}'s task operation failed",
        }
      );
    }
  }

  if (!isAgentOrgBubble) {
    return t("simulator.replay.messages.bubble.senderTitle.updatedTodos", {
      ns: "sessions",
      subject,
      defaultValue: "{{subject}} updated to-dos",
    });
  }

  switch (action) {
    case "create":
      return t("simulator.replay.messages.bubble.senderTitle.taskCreated", {
        ns: "sessions",
        subject,
        defaultValue: "{{subject}} created task",
      });
    case "update":
      return t("simulator.replay.messages.bubble.senderTitle.taskUpdated", {
        ns: "sessions",
        subject,
        defaultValue: "{{subject}} updated task",
      });
    case "delete":
      return t("simulator.replay.messages.bubble.senderTitle.taskDeleted", {
        ns: "sessions",
        subject,
        defaultValue: "{{subject}} deleted task",
      });
    case "get":
      return t("simulator.replay.messages.bubble.senderTitle.taskViewed", {
        ns: "sessions",
        subject,
        defaultValue: "{{subject}} viewed task details",
      });
    case "list":
      return t("simulator.replay.messages.bubble.senderTitle.taskListed", {
        ns: "sessions",
        subject,
        defaultValue: "{{subject}} viewed task list",
      });
    default:
      return subject;
  }
}

export const OrgTaskEventBubble: React.FC<OrgTaskBubbleProps> = memo(
  ({ message, onClick, onNavigateToTodoList, orgMembers }) => {
    const { t } = useTranslation(["common", "sessions"]);
    const extracted = message.event.extracted;

    const { rawAgentName, agentIcon, isAgentOrgBubble } =
      useCommunicationAgentIdentity(message.event, orgMembers);
    const senderName = useMemo(
      () =>
        resolveOrgTaskTitle(message.event, rawAgentName, t, isAgentOrgBubble),
      [isAgentOrgBubble, message.event, rawAgentName, t]
    );

    // List / get → render the standalone TaskListCard with the navigate
    // arrow wired up. This bypasses the chat-panel adapter so we can
    // surface the simulator-only navigate affordance.
    if (
      extracted?.kind === "orgTask" &&
      (extracted.action === "list" || extracted.action === "get")
    ) {
      const tasks =
        extracted.action === "get"
          ? extracted.task
            ? [extracted.task]
            : (extracted.tasks ?? [])
          : (extracted.tasks ?? []);
      const card: TaskListCardData = {
        kind: extracted.action === "get" ? "get" : "list",
        tasks: tasks.map(orgTaskItemToCardData),
        total: extracted.total,
        orgRunId: extracted.orgRunId,
      };
      return (
        <Framed
          message={message}
          senderName={senderName}
          icon={agentIcon}
          onClick={onClick}
        >
          <TaskListCard
            card={card}
            onNavigate={onNavigateToTodoList}
            hideHeader
          />
        </Framed>
      );
    }

    // create / update / delete → reuse the chat-panel adapter (renders
    // `OrgTaskBlock` in its header-less variant via the simulator-aware
    // `variant === "simulator"` branch).
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
