import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import type { TaskListCardData } from "@src/engines/ChatPanel/blocks/ToolCallBlock/types";
import { orgTaskItemToCardData } from "@src/engines/ChatPanel/rendering/adapters";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { prettifyMemberName } from "@src/util/data/formatters/memberName";

const ORG_TASK_FUNCTION_NAMES = new Set([
  "task_create",
  "task_update",
  "task_list",
  "task_get",
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
    case "task_create":
      return "create";
    case "task_update":
      return "update";
    case "task_get":
      return "get";
    case "task_list":
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
  const title = titles[resolveOrgTaskAction(event) ?? ""];
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
