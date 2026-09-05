import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  AGENT_ORG_TASK_STATUS,
  type AgentOrgTask,
  type AgentOrgTaskAnnotationPage,
  type AgentOrgTaskStatus,
  agentOrgTaskStatusSatisfiesDependency,
  getAgentOrgTaskAnnotationPage,
  getAgentOrgTaskDetail,
  isAgentOrgTaskTerminalStatus,
} from "@src/api/tauri/agent";
import Button from "@src/components/Button";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  BubbleChatIcon,
  Cancel01Icon,
  ChevronsDownUpIcon,
  HugeiconsIcon,
  LockIcon,
  Refresh04Icon,
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
  if (
    blocked &&
    (status === AGENT_ORG_TASK_STATUS.PENDING ||
      status === AGENT_ORG_TASK_STATUS.IN_PROGRESS)
  ) {
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

  if (status === AGENT_ORG_TASK_STATUS.FAILED) {
    return (
      <span
        className={`${TASK_STATUS_CHIP_BASE} bg-error-6/10 text-error-6`}
        data-testid="agent-org-task-status-chip"
      >
        {label}
      </span>
    );
  }

  if (status === AGENT_ORG_TASK_STATUS.CANCELLED) {
    return (
      <span
        className={`${TASK_STATUS_CHIP_BASE} bg-text-3/10 text-text-3`}
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
  if (
    blocked &&
    (status === AGENT_ORG_TASK_STATUS.PENDING ||
      status === AGENT_ORG_TASK_STATUS.IN_PROGRESS)
  ) {
    return "planner.agentOrgTasks.statusBlocked";
  }
  if (status === AGENT_ORG_TASK_STATUS.COMPLETED) {
    return "planner.agentOrgTasks.statusCompleted";
  }
  if (status === AGENT_ORG_TASK_STATUS.IN_PROGRESS) {
    return "planner.agentOrgTasks.statusInProgress";
  }
  if (status === AGENT_ORG_TASK_STATUS.FAILED) {
    return "planner.agentOrgTasks.statusFailed";
  }
  if (status === AGENT_ORG_TASK_STATUS.CANCELLED) {
    return "planner.agentOrgTasks.statusCancelled";
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
  if (status === AGENT_SESSION_STATUS.COMPLETED) return "bg-success-6";
  return "bg-text-3/50";
}

function isTaskBlocked(
  task: AgentOrgTask,
  tasksById: Map<string, AgentOrgTask>
) {
  if (task.dependenciesSatisfied !== undefined) {
    return !task.dependenciesSatisfied;
  }
  return task.blockedBy.some((taskId) => {
    const blocker = tasksById.get(taskId);
    return (
      blocker === undefined ||
      !agentOrgTaskStatusSatisfiesDependency(blocker.status)
    );
  });
}

function retainVisibleRecords<T>(
  records: Record<string, T>,
  visibleTaskIds: Set<string>
): Record<string, T> {
  const entries = Object.entries(records).filter(([taskId]) =>
    visibleTaskIds.has(taskId)
  );
  return entries.length === Object.keys(records).length
    ? records
    : Object.fromEntries(entries);
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
        className={`chat-block-title min-w-0 text-sm leading-5 text-text-1 ${done ? "text-text-3! line-through" : ""}`}
        title={task.description || task.subject}
      >
        {task.subject}
      </span>
    );
  }

  return (
    <button
      type="button"
      className={`chat-block-title flex min-w-0 flex-1 items-start gap-1 text-left text-sm leading-5 text-text-1 focus-visible:ring-2 focus-visible:ring-primary-6/30 focus-visible:outline-none ${done ? "text-text-3! line-through" : ""}`}
      title={task.description || task.subject}
      aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}
    >
      <span
        className={
          expanded
            ? "max-h-32 min-w-0 flex-1 overflow-y-auto wrap-break-word whitespace-pre-wrap"
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
  currentRunId?: string;
  awaitingApprovalTaskIds?: string[];
  canManageTasks?: boolean;
  onTaskAction?: (task: AgentOrgTask, action: "cancel" | "reassign") => void;
}

export const AgentOrgTaskList: React.FC<AgentOrgTaskListProps> = memo(
  ({
    tasks,
    listTestId,
    rowTestId,
    className = "px-1 pb-1",
    currentSessionId,
    currentRunId,
    awaitingApprovalTaskIds = [],
    canManageTasks = false,
    onTaskAction,
  }) => {
    const { t } = useTranslation("sessions");
    const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
    const [details, setDetails] = useState<Record<string, AgentOrgTask>>({});
    const [annotationPages, setAnnotationPages] = useState<
      Record<string, AgentOrgTaskAnnotationPage>
    >({});
    const [loadingTaskId, setLoadingTaskId] = useState<string | null>(null);
    const [annotationLoadingTaskId, setAnnotationLoadingTaskId] = useState<
      string | null
    >(null);
    const [detailErrorTaskId, setDetailErrorTaskId] = useState<string | null>(
      null
    );
    const detailRequestIdRef = useRef(0);
    const currentSessionIdRef = useRef(currentSessionId);
    const currentRunIdRef = useRef(currentRunId);
    const visibleTaskIdsRef = useRef(new Set(tasks.map((task) => task.id)));
    currentSessionIdRef.current = currentSessionId;
    currentRunIdRef.current = currentRunId;
    visibleTaskIdsRef.current = new Set(tasks.map((task) => task.id));

    useEffect(() => {
      detailRequestIdRef.current += 1;
      setExpandedTaskId(null);
      setDetails({});
      setAnnotationPages({});
      setLoadingTaskId(null);
      setAnnotationLoadingTaskId(null);
      setDetailErrorTaskId(null);
    }, [currentRunId, currentSessionId]);

    useEffect(() => {
      const visibleTaskIds = new Set(tasks.map((task) => task.id));
      setDetails((previous) => retainVisibleRecords(previous, visibleTaskIds));
      setAnnotationPages((previous) =>
        retainVisibleRecords(previous, visibleTaskIds)
      );
      if (expandedTaskId && !visibleTaskIds.has(expandedTaskId)) {
        detailRequestIdRef.current += 1;
        setExpandedTaskId(null);
        setLoadingTaskId(null);
        setAnnotationLoadingTaskId(null);
        setDetailErrorTaskId(null);
      }
    }, [expandedTaskId, tasks]);

    const toggleDetail = useCallback(
      async (task: AgentOrgTask) => {
        if (expandedTaskId === task.id) {
          detailRequestIdRef.current += 1;
          setExpandedTaskId(null);
          setLoadingTaskId(null);
          setAnnotationLoadingTaskId(null);
          return;
        }
        setExpandedTaskId(task.id);
        if (!currentSessionId || details[task.id]) return;
        const sessionId = currentSessionId;
        const runId = currentRunId;
        const requestId = ++detailRequestIdRef.current;
        setLoadingTaskId(task.id);
        setDetailErrorTaskId(null);
        try {
          const [detail, annotationPage] = await Promise.all([
            getAgentOrgTaskDetail({
              sessionId,
              taskId: task.id,
            }),
            getAgentOrgTaskAnnotationPage({
              sessionId,
              taskId: task.id,
            }),
          ]);
          if (
            detailRequestIdRef.current !== requestId ||
            currentSessionIdRef.current !== sessionId ||
            currentRunIdRef.current !== runId ||
            !visibleTaskIdsRef.current.has(task.id)
          ) {
            return;
          }
          setDetails((previous) => ({ ...previous, [task.id]: detail }));
          setAnnotationPages((previous) => ({
            ...previous,
            [task.id]: annotationPage,
          }));
        } catch {
          if (
            detailRequestIdRef.current === requestId &&
            currentSessionIdRef.current === sessionId &&
            currentRunIdRef.current === runId &&
            visibleTaskIdsRef.current.has(task.id)
          ) {
            setDetailErrorTaskId(task.id);
          }
        } finally {
          if (
            detailRequestIdRef.current === requestId &&
            currentSessionIdRef.current === sessionId &&
            currentRunIdRef.current === runId &&
            visibleTaskIdsRef.current.has(task.id)
          ) {
            setLoadingTaskId(null);
          }
        }
      },
      [currentRunId, currentSessionId, details, expandedTaskId]
    );

    const loadMoreAnnotations = useCallback(
      async (taskId: string) => {
        const annotationPage = annotationPages[taskId];
        if (
          !currentSessionId ||
          !annotationPage?.hasMore ||
          !annotationPage.nextCursor
        ) {
          return;
        }
        const sessionId = currentSessionId;
        const runId = currentRunId;
        const requestId = ++detailRequestIdRef.current;
        setAnnotationLoadingTaskId(taskId);
        try {
          const nextPage = await getAgentOrgTaskAnnotationPage({
            sessionId,
            taskId,
            cursor: annotationPage.nextCursor,
          });
          if (
            detailRequestIdRef.current !== requestId ||
            currentSessionIdRef.current !== sessionId ||
            currentRunIdRef.current !== runId ||
            !visibleTaskIdsRef.current.has(taskId)
          ) {
            return;
          }
          setAnnotationPages((previous) => {
            const currentPage = previous[taskId];
            if (!currentPage) return previous;
            const seen = new Set(
              currentPage.annotations.map((annotation) => annotation.id)
            );
            return {
              ...previous,
              [taskId]: {
                ...nextPage,
                annotations: [
                  ...currentPage.annotations,
                  ...nextPage.annotations.filter(
                    (annotation) => !seen.has(annotation.id)
                  ),
                ],
              },
            };
          });
        } catch {
          if (
            detailRequestIdRef.current === requestId &&
            currentSessionIdRef.current === sessionId &&
            currentRunIdRef.current === runId &&
            visibleTaskIdsRef.current.has(taskId)
          ) {
            setDetailErrorTaskId(taskId);
          }
        } finally {
          if (
            detailRequestIdRef.current === requestId &&
            currentSessionIdRef.current === sessionId &&
            currentRunIdRef.current === runId &&
            visibleTaskIdsRef.current.has(taskId)
          ) {
            setAnnotationLoadingTaskId(null);
          }
        }
      },
      [annotationPages, currentRunId, currentSessionId]
    );

    const tasksById = new Map(tasks.map((task) => [task.id, task]));
    const awaitingApprovalTaskIdSet = new Set(awaitingApprovalTaskIds);

    return (
      <div className={`${className} space-y-2`} data-testid={listTestId}>
        {tasks.map((task) => {
          const blocked = isTaskBlocked(task, tasksById);
          const done = task.status === AGENT_ORG_TASK_STATUS.COMPLETED;
          const terminal = isAgentOrgTaskTerminalStatus(task.status);
          const awaitingApproval =
            task.status === AGENT_ORG_TASK_STATUS.IN_PROGRESS &&
            awaitingApprovalTaskIdSet.has(task.id);
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
              className={`rounded-lg border border-border-1 bg-bg-1/90 px-3 py-2 shadow-xs transition-colors hover:bg-bg-2/80 ${blocked ? "opacity-70" : ""}`}
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
                {awaitingApproval ? (
                  <span
                    className={`${TASK_STATUS_CHIP_BASE} bg-warning-6/10 text-warning-6`}
                    data-testid="agent-org-task-awaiting-approval-chip"
                  >
                    {t("planner.agentOrgTasks.statusAwaitingApproval", {
                      defaultValue: "Awaiting approval",
                    })}
                  </span>
                ) : null}
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
              {canManageTasks && !terminal && (
                <div className="mt-2 flex items-center justify-end gap-1">
                  {task.status === AGENT_ORG_TASK_STATUS.IN_PROGRESS && (
                    <Button
                      size="mini"
                      variant="tertiary"
                      appearance="ghost"
                      icon={
                        <HugeiconsIcon
                          icon={Refresh04Icon}
                          data-icon="refresh"
                          size={10}
                          strokeWidth={2}
                        />
                      }
                      onClick={() => onTaskAction?.(task, "reassign")}
                      data-testid="agent-org-task-reassign-button"
                    >
                      {t("planner.agentOrgTasks.reassign", {
                        defaultValue: "Reassign",
                      })}
                    </Button>
                  )}
                  <Button
                    size="mini"
                    variant="danger"
                    appearance="ghost"
                    icon={
                      <HugeiconsIcon
                        icon={Cancel01Icon}
                        data-icon="cancel"
                        size={10}
                        strokeWidth={2}
                      />
                    }
                    onClick={() => onTaskAction?.(task, "cancel")}
                    data-testid="agent-org-task-cancel-button"
                  >
                    {t("planner.agentOrgTasks.cancelTask", {
                      defaultValue: "Cancel",
                    })}
                  </Button>
                </div>
              )}
              {terminal && currentSessionId && (
                <button
                  type="button"
                  className="mt-2 inline-flex items-center gap-1 text-[10px] text-text-2 hover:text-text-1 focus-visible:ring-2 focus-visible:ring-primary-6/30 focus-visible:outline-none"
                  aria-expanded={expandedTaskId === task.id}
                  onClick={() => void toggleDetail(task)}
                  data-testid="agent-org-task-detail-toggle"
                >
                  <HugeiconsIcon
                    icon={
                      expandedTaskId === task.id
                        ? ArrowDown01Icon
                        : ArrowRight01Icon
                    }
                    data-icon={
                      expandedTaskId === task.id
                        ? "chevron-down"
                        : "chevron-right"
                    }
                    size={11}
                    strokeWidth={2}
                  />
                  {t("planner.agentOrgTasks.details")}
                </button>
              )}
              {expandedTaskId === task.id && terminal && (
                <div
                  className="mt-2 space-y-2 rounded-md bg-bg-2 p-2 text-[11px] text-text-2"
                  data-testid="agent-org-task-detail"
                  role="region"
                  aria-label={`${task.subject} · ${t("planner.agentOrgTasks.details")}`}
                >
                  {loadingTaskId === task.id && (
                    <div role="status">
                      {t("planner.agentOrgTasks.loadingDetails")}
                    </div>
                  )}
                  {detailErrorTaskId === task.id && (
                    <div className="text-error-6" role="alert">
                      {t("planner.agentOrgTasks.detailLoadFailed")}
                    </div>
                  )}
                  {(details[task.id]?.output ?? task.outputSummary) && (
                    <div className="break-words whitespace-pre-wrap">
                      <div className="font-medium text-text-1">
                        {t("planner.agentOrgTasks.output")}
                      </div>
                      {details[task.id]?.output?.summary ??
                        task.outputSummary?.summary}
                      {details[task.id]?.output?.content && (
                        <div className="mt-1 max-h-40 overflow-y-auto break-words whitespace-pre-wrap">
                          {details[task.id].output?.content}
                        </div>
                      )}
                    </div>
                  )}
                  {(details[task.id]?.failureReason ?? task.failureReason) && (
                    <div className="text-error-6 break-words whitespace-pre-wrap">
                      {
                        (details[task.id]?.failureReason ?? task.failureReason)
                          ?.message
                      }
                    </div>
                  )}
                  {(details[task.id]?.cancelReason ?? task.cancelReason) && (
                    <div className="break-words whitespace-pre-wrap">
                      {
                        (details[task.id]?.cancelReason ?? task.cancelReason)
                          ?.message
                      }
                    </div>
                  )}
                  {(annotationPages[task.id]?.annotations.length ?? 0) > 0 && (
                    <div className="space-y-1">
                      <div className="font-medium text-text-1">
                        {t("planner.agentOrgTasks.annotations")}
                      </div>
                      {annotationPages[task.id].annotations.map(
                        (annotation) => (
                          <div key={annotation.id} className="break-words">
                            <span className="mr-1 text-text-3">
                              {annotation.kind.replace("_", " ")}
                            </span>
                            {annotation.body}
                          </div>
                        )
                      )}
                      {annotationPages[task.id].hasMore && (
                        <button
                          type="button"
                          className="text-primary-6 focus-visible:ring-2 focus-visible:ring-primary-6/30 focus-visible:outline-none disabled:opacity-40"
                          disabled={annotationLoadingTaskId === task.id}
                          onClick={() => void loadMoreAnnotations(task.id)}
                          data-testid="agent-org-task-annotations-load-more"
                        >
                          {t("planner.agentOrgTasks.loadMoreAnnotations")}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    );
  }
);

AgentOrgTaskList.displayName = "AgentOrgTaskList";
