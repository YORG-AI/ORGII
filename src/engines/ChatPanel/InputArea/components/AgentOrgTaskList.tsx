import React, { memo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AGENT_ORG_TASK_STATUS,
  type AgentOrgTask,
  type AgentOrgTaskStatus,
} from "@src/api/tauri/agent";
import {
  BubbleChatIcon,
  ChevronsDownUpIcon,
  HugeiconsIcon,
  LockIcon,
  UnfoldMoreIcon,
} from "@src/icons";

const TASK_STATUS_CHIP_BASE =
  "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium leading-4";

const AGENT_SESSION_STATUS = {
  RUNNING: "running",
  WAITING_FOR_USER: "waiting_for_user",
  FAILED: "failed",
  CANCELLED: "cancelled",
  ABANDONED: "abandoned",
  TIMEOUT: "timeout",
  COMPLETED: "completed",
} as const;

const FAILURE_SESSION_STATUSES = new Set<string>([
  AGENT_SESSION_STATUS.FAILED,
  AGENT_SESSION_STATUS.CANCELLED,
  AGENT_SESSION_STATUS.ABANDONED,
  AGENT_SESSION_STATUS.TIMEOUT,
]);

function TaskStatusChip({
  status,
  blocked,
  label,
}: {
  status: AgentOrgTaskStatus;
  blocked: boolean;
  label: string;
}) {
  if (blocked && status !== AGENT_ORG_TASK_STATUS.COMPLETED) {
    return (
      <span
        className={`${TASK_STATUS_CHIP_BASE} bg-warning-6/10 text-warning-6`}
        data-testid="agent-org-task-status-chip"
      >
        {label}
      </span>
    );
  }

  if (status === AGENT_ORG_TASK_STATUS.COMPLETED) {
    return (
      <span
        className={`${TASK_STATUS_CHIP_BASE} bg-success-6/10 text-success-6`}
        data-testid="agent-org-task-status-chip"
      >
        {label}
      </span>
    );
  }

  if (status === AGENT_ORG_TASK_STATUS.IN_PROGRESS) {
    return (
      <span
        className={`${TASK_STATUS_CHIP_BASE} bg-primary-6/10 text-primary-6`}
        data-testid="agent-org-task-status-chip"
      >
        {label}
      </span>
    );
  }

  return (
    <span
      className={`${TASK_STATUS_CHIP_BASE} bg-fill-3 text-text-3`}
      data-testid="agent-org-task-status-chip"
    >
      {label}
    </span>
  );
}

function getTaskStatusLabelKey(
  status: AgentOrgTaskStatus,
  blocked: boolean
): string {
  if (blocked && status !== AGENT_ORG_TASK_STATUS.COMPLETED) {
    return "planner.agentOrgTasks.statusBlocked";
  }
  if (status === AGENT_ORG_TASK_STATUS.COMPLETED) {
    return "planner.agentOrgTasks.statusCompleted";
  }
  if (status === AGENT_ORG_TASK_STATUS.IN_PROGRESS) {
    return "planner.agentOrgTasks.statusInProgress";
  }
  return "planner.agentOrgTasks.statusPending";
}

function formatOwner(task: AgentOrgTask): string | null {
  if (task.ownerMember) {
    return `${task.ownerMember.name} · ${task.ownerMember.role}`;
  }
  if (!task.owner) return null;
  return task.owner.replace(/^builtin:/, "");
}

function formatSessionStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function ownerRuntimeClass(status: string): string {
  if (status === AGENT_SESSION_STATUS.RUNNING) return "bg-primary-6";
  if (status === AGENT_SESSION_STATUS.WAITING_FOR_USER) {
    return "bg-warning-6";
  }
  if (FAILURE_SESSION_STATUSES.has(status)) return "bg-error-6";
  if (status === AGENT_SESSION_STATUS.COMPLETED) return "bg-green-600";
  return "bg-text-3/50";
}

function isTaskBlocked(
  task: AgentOrgTask,
  tasksById: Map<string, AgentOrgTask>
) {
  return task.blockedBy.some((taskId) => {
    const blocker = tasksById.get(taskId);
    return blocker?.status !== AGENT_ORG_TASK_STATUS.COMPLETED;
  });
}

function AgentOrgTaskSubject({
  task,
  done,
}: {
  task: AgentOrgTask;
  done: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const text = task.subject || task.description;
  const hasLongText = text.length > 120 || text.includes("\n");

  if (!hasLongText) {
    return (
      <span
        className={`chat-block-title min-w-0 text-sm leading-5 text-text-1 ${done ? "!text-text-3 line-through" : ""}`}
        title={task.description || task.subject}
      >
        {task.subject}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={`chat-block-title flex min-w-0 flex-1 items-start gap-1 text-left text-sm leading-5 text-text-1 ${done ? "!text-text-3 line-through" : ""}`}
      title={task.description || task.subject}
      aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}
    >
      <span
        className={
          expanded
            ? "max-h-32 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words"
            : "min-w-0 flex-1 truncate"
        }
      >
        {text}
      </span>
      {expanded ? (
        <HugeiconsIcon
          icon={ChevronsDownUpIcon}
          data-icon="chevrons-down-up"
          size={11}
          strokeWidth={2}
          className="mt-0.5 shrink-0 text-text-3"
        />
      ) : (
        <HugeiconsIcon
          icon={UnfoldMoreIcon}
          data-icon="chevrons-up-down"
          size={11}
          strokeWidth={2}
          className="mt-0.5 shrink-0 text-text-3"
        />
      )}
    </button>
  );
}

interface AgentOrgTaskListProps {
  tasks: AgentOrgTask[];
  listTestId: string;
  rowTestId: string;
  className?: string;
  currentSessionId?: string;
}

export const AgentOrgTaskList: React.FC<AgentOrgTaskListProps> = memo(
  ({ tasks, listTestId, rowTestId, className = "px-1 pb-1" }) => {
    const { t } = useTranslation("sessions");

    const tasksById = new Map(tasks.map((task) => [task.id, task]));

    return (
      <div className={`${className} space-y-2`} data-testid={listTestId}>
        {tasks.map((task) => {
          const blocked = isTaskBlocked(task, tasksById);
          const done = task.status === AGENT_ORG_TASK_STATUS.COMPLETED;
          const statusLabel = t(getTaskStatusLabelKey(task.status, blocked));
          const owner = formatOwner(task);
          const ownerRuntime = task.ownerRuntime;
          const ownerRuntimeLabel = ownerRuntime
            ? formatSessionStatus(ownerRuntime.status)
            : null;
          const ownerIntervention = ownerRuntime?.intervention ?? null;
          const showOwnerRuntimeStatus = Boolean(ownerRuntime) && !done;
          return (
            <div
              key={task.id}
              className={`rounded-lg border border-border-1 bg-bg-1/90 px-3 py-2 shadow-sm transition-colors hover:bg-bg-2/80 ${blocked ? "opacity-70" : ""}`}
              data-testid={rowTestId}
              data-task-id={task.id}
              data-task-status={task.status}
              data-task-owner={task.owner ?? ""}
              data-task-blocked={blocked ? "true" : "false"}
            >
              <div className="flex min-w-0 items-start gap-3">
                <TaskStatusChip
                  status={task.status}
                  blocked={blocked}
                  label={statusLabel}
                />
                <div className="min-w-0 flex-1">
                  <AgentOrgTaskSubject task={task} done={done} />
                  {(owner || blocked) && (
                    <div className="mt-2 flex min-w-0 flex-wrap items-center gap-2 text-[10px] leading-4 text-text-3">
                      {owner && (
                        <span
                          className="inline-flex max-w-full items-center gap-2 rounded-full bg-bg-2 px-2 py-0.5"
                          data-testid="agent-org-task-owner-meta"
                          data-owner-member-id={task.owner ?? ""}
                          data-owner-session-id={ownerRuntime?.sessionId ?? ""}
                          title={
                            ownerRuntime && ownerRuntimeLabel
                              ? `${t("planner.agentOrgTasks.owner", { owner })} · ${ownerRuntimeLabel}`
                              : t("planner.agentOrgTasks.ownerNoSession", {
                                  owner,
                                })
                          }
                        >
                          <span className="min-w-0 truncate">
                            {t("planner.agentOrgTasks.owner", { owner })}
                          </span>
                          {showOwnerRuntimeStatus && ownerRuntime && (
                            <span className="flex shrink-0 items-center gap-1.5">
                              <span
                                className={`h-1.5 w-1.5 rounded-full ${ownerRuntimeClass(ownerRuntime.status)}`}
                              />
                              <span>{ownerRuntimeLabel}</span>
                            </span>
                          )}
                          {ownerIntervention && !done && (
                            <span
                              className="flex shrink-0 items-center gap-1 rounded-full bg-warning-6/10 px-1.5 py-0.5 text-warning-6"
                              data-testid="agent-org-task-owner-intervention-badge"
                              title={t(
                                "planner.agentOrgIntervention.teammateBusy"
                              )}
                            >
                              <HugeiconsIcon
                                icon={BubbleChatIcon}
                                data-icon="message-circle"
                                size={8}
                                strokeWidth={2}
                              />
                              <span>
                                {t("planner.agentOrgIntervention.busyShort")}
                              </span>
                            </span>
                          )}
                        </span>
                      )}
                      {blocked && (
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-warning-6/10 px-2 py-0.5 text-warning-6">
                          <HugeiconsIcon
                            icon={LockIcon}
                            data-icon="lock"
                            size={8}
                            strokeWidth={2}
                          />
                          {task.blockedBy.length}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    );
  }
);

AgentOrgTaskList.displayName = "AgentOrgTaskList";
