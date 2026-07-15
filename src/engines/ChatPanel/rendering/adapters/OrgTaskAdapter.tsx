import React from "react";

import { useAgentTurnContext } from "@src/engines/ChatPanel/ChatHistory/AgentTurnContext";
import type { RustOrgTaskItem } from "@src/engines/SessionCore/core/types";
import { resolveOrgTaskOperationOutcome } from "@src/engines/SessionCore/rendering/orgTaskOutcome";
import {
  statusToLifecycle,
  useLifecycleLabels,
} from "@src/engines/SessionCore/rendering/registry";
import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";
import { prettifyMemberName } from "@src/util/data/formatters/memberName";

import OrgTaskBlock, { type OrgTaskAction } from "../../blocks/OrgTaskBlock";
import ToolCallBlock from "../../blocks/ToolCallBlock";
import { TaskListCard } from "../../blocks/ToolCallBlock/cards/TaskUpdateCard";
import type {
  TaskListCardData,
  TaskUpdateCardData,
} from "../../blocks/ToolCallBlock/types";

function taskTitle(task: RustOrgTaskItem): string {
  return task.subject ?? task.activeForm ?? task.description ?? task.id;
}

export function resolveOrgTaskOwnerDisplay(
  task: RustOrgTaskItem
): string | undefined {
  if (task.ownerName) return task.ownerName;
  if (task.owner) return prettifyMemberName(task.owner);
  return undefined;
}

export function orgTaskItemToCardData(
  task: RustOrgTaskItem
): TaskUpdateCardData {
  return {
    action: "updated",
    id: task.id,
    subject: task.subject,
    activeForm: task.activeForm,
    status: task.status,
    owner: resolveOrgTaskOwnerDisplay(task),
    blocks: task.blocks ?? [],
    blockedBy: task.blockedBy ?? [],
  };
}

function renderListCard(
  props: UniversalEventProps,
  groupSenderName?: string | null
) {
  if (props.rustExtracted?.kind !== "orgTask") return null;
  const extracted = props.rustExtracted;
  const tasks = extracted.tasks ?? [];
  const card: TaskListCardData = {
    kind: extracted.action === "get" ? "get" : "list",
    tasks: tasks.map(orgTaskItemToCardData),
    total: extracted.total,
    orgRunId: extracted.orgRunId,
  };
  return (
    <div
      data-tool-call-event-id={props.eventId}
      data-tool-call-name={props.functionName ?? props.eventType}
    >
      <TaskListCard
        card={card}
        hideHeader={props.variant === "simulator"}
        groupSenderName={groupSenderName}
      />
    </div>
  );
}

export const OrgTaskAdapter: React.FC<UniversalEventProps> = (props) => {
  const turnContext = useAgentTurnContext();
  const labels = useLifecycleLabels(props.eventType, undefined);
  const state = statusToLifecycle(props.status);
  const title =
    labels[state] || props.functionName || props.eventType || "Task";
  const groupSenderName = turnContext?.groupSenderName ?? null;

  if (props.rustExtracted?.kind !== "orgTask") {
    return (
      <ToolCallBlock
        toolName={props.functionName || props.eventType || "task"}
        title={title}
        args={props.args}
        result={props.result}
        isLoading={
          props.status === "running" && props.showActiveEventPainting === true
        }
        defaultCollapsed={false}
        eventId={props.eventId}
        callId={props.callId}
        sessionId={props.sessionId}
        payloadRefs={props.payloadRefs}
      />
    );
  }

  const extracted = props.rustExtracted;
  const isSimulator = props.variant === "simulator";
  const operationOutcome = resolveOrgTaskOperationOutcome(
    extracted,
    props.result,
    props.status
  );

  if (extracted.action === "list" && operationOutcome === "succeeded")
    return renderListCard(props, groupSenderName);
  const task = extracted.task ?? extracted.tasks?.[0];
  if (!task) {
    return (
      <ToolCallBlock
        toolName={props.functionName || props.eventType || "task"}
        title={title}
        args={props.args}
        result={props.result}
        isLoading={operationOutcome === "pending"}
        defaultCollapsed={false}
        eventId={props.eventId}
        callId={props.callId}
        sessionId={props.sessionId}
        payloadRefs={props.payloadRefs}
      />
    );
  }

  if (extracted.action === "get" && operationOutcome === "succeeded") {
    return renderListCard(
      {
        ...props,
        rustExtracted: {
          ...extracted,
          tasks: [task],
        },
      },
      groupSenderName
    );
  }

  const blockAction: OrgTaskAction =
    extracted.action === "create" ? "create" : "update";

  return (
    <div
      data-tool-call-event-id={props.eventId}
      data-tool-call-name={props.functionName ?? props.eventType}
    >
      <OrgTaskBlock
        action={blockAction}
        title={taskTitle(task)}
        description={task.description}
        ownerName={resolveOrgTaskOwnerDisplay(task)}
        status={task.status}
        priority={task.priority}
        blocks={task.blocks ?? []}
        blockedBy={task.blockedBy ?? []}
        ownerChanged={extracted.ownerChanged}
        statusChanged={extracted.statusChanged}
        taskAssignedDispatched={extracted.taskAssignedDispatched}
        operationOutcome={operationOutcome}
        operationMessage={extracted.guidance ?? extracted.errorMessage}
        isLoading={
          props.status === "running" && props.showActiveEventPainting === true
        }
        eventId={props.eventId}
        timestamp={props.timestamp}
        hideHeader={isSimulator}
        groupSenderName={groupSenderName}
        toolUsage={props.toolUsage}
      />
    </div>
  );
};

OrgTaskAdapter.displayName = "OrgTaskAdapter";

export default OrgTaskAdapter;
