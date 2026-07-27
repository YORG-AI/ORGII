import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import { TOOL_NAMES } from "@src/api/tauri/agent";
import type { TaskListCardData } from "@src/engines/ChatPanel/blocks/ToolCallBlock/types";
import { orgTaskItemToCardData } from "@src/engines/ChatPanel/rendering/adapters";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { resolveOrgTaskOperationOutcome } from "@src/engines/SessionCore/rendering/orgTaskOutcome";
import { prettifyMemberName } from "@src/util/data/formatters/memberName";

const ORG_TASK_FUNCTION_NAMES = new Set<string>([
  TOOL_NAMES.TASK_CREATE,
  TOOL_NAMES.TASK_GRAPH_CREATE,
  TOOL_NAMES.TASK_UPDATE,
  TOOL_NAMES.TASK_LIST,
  TOOL_NAMES.TASK_GET,
]);

type BubbleTranslation = (
  key: string,
  options: Record<string, unknown>
) => string;

export function isOrgTaskEvent(event: SessionEvent): boolean {
  if (event.extracted?.kind === "orgTask") return true;
  return ORG_TASK_FUNCTION_NAMES.has(event.functionName);
}

export function resolveRecipientLabel(
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

function resolveOrgTaskAction(event: SessionEvent): string | null {
  if (event.extracted?.kind === "orgTask") return event.extracted.action;
  switch (event.functionName) {
    case TOOL_NAMES.TASK_CREATE:
    case TOOL_NAMES.TASK_GRAPH_CREATE:
      return "create";
    case TOOL_NAMES.TASK_UPDATE:
      return "update";
    case TOOL_NAMES.TASK_GET:
      return "get";
    case TOOL_NAMES.TASK_LIST:
      return "list";
    default:
      return null;
  }
}

export function resolveOrgTaskTitle(
  event: SessionEvent,
  subject: string,
  t: BubbleTranslation,
  isAgentOrgBubble: boolean
): string {
  const action = resolveOrgTaskAction(event);

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

  const titles: Record<string, [string, string]> = {
    create: ["taskCreated", "{{subject}} created task"],
    update: ["taskUpdated", "{{subject}} updated task"],
    delete: ["taskDeleted", "{{subject}} deleted task"],
    get: ["taskViewed", "{{subject}} viewed task details"],
    list: ["taskListed", "{{subject}} viewed task list"],
  };
  const title = titles[action ?? ""];
  if (!title) return subject;
  return t(`simulator.replay.messages.bubble.senderTitle.${title[0]}`, {
    ns: "sessions",
    subject,
    defaultValue: title[1],
  });
}

export function buildTaskListCard(
  event: SessionEvent
): TaskListCardData | null {
  const extracted = event.extracted;
  if (
    extracted?.kind !== "orgTask" ||
    (extracted.action !== "list" && extracted.action !== "get")
  ) {
    return null;
  }

  const tasks =
    extracted.action === "get"
      ? extracted.task
        ? [extracted.task]
        : (extracted.tasks ?? [])
      : (extracted.tasks ?? []);

  return {
    kind: extracted.action,
    tasks: tasks.map(orgTaskItemToCardData),
    total: extracted.total,
    orgRunId: extracted.orgRunId,
  };
}
