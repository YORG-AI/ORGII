import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  BENCHMARK_AGENT_BATCH_STATUS,
  BENCHMARK_BATCH_TASK_ACTION,
  BENCHMARK_EVALUATION_MODE,
  BENCHMARK_KIND,
  BENCHMARK_RUN_STATUS,
  type BenchmarkAgentBatchItem,
  type BenchmarkBatchTaskAction,
  type BenchmarkTaskIndexRow,
  benchmarkApi,
} from "@src/api/tauri/benchmark";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Markdown from "@src/components/MarkDown";
import ModelIcon from "@src/components/ModelIcon";
import TabPill from "@src/components/TabPill";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import BenchmarkTaskSelector from "@src/features/BenchmarkPanel/BenchmarkTaskSelector";
import { CodeMirrorEditor } from "@src/features/CodeMirror";
import {
  listBenchmarkTasksShared,
  setBenchmarkAgentBatchStatusShared,
} from "@src/hooks/benchmark/benchmarkRequestCoordinator";
import { useBenchmarkAgentBatchRun } from "@src/hooks/benchmark/useBenchmarkAgentBatchRun";
import { useBenchmarkTasks } from "@src/hooks/benchmark/useBenchmarkTasks";
import { usePublishWorkstationTabHeader } from "@src/hooks/workStation";
import {
  Placeholder,
  SessionGroupPage,
  type SessionTableItem,
} from "@src/modules/shared/layouts/blocks";
import {
  BENCHMARK_TASK_LIST_LIMIT,
  benchmarkActiveBatchTaskIdAtom,
  benchmarkAgentBatchStatusAtom,
} from "@src/store/benchmark";
import {
  activeSessionIdAtom,
  loadSessions,
  sessionsAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import {
  CHAT_PANEL_CONTENT_MODE,
  chatPanelContentModeAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  formatReplayDateLabel,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";
import { formatModelNameFull } from "@src/util/formatModelName";

type BenchmarkPanelSurface = "taskInfo" | "runList";

interface BenchmarkPanelProps {
  className?: string;
  surface?: BenchmarkPanelSurface;
  publishHeader?: boolean;
}

function formatTaskMarkdown(
  taskId: string,
  title: string,
  repo: string | null | undefined,
  instruction: string
): string {
  const metadata = [repo ? `Repo: ${repo}` : null, `Task: ${taskId}`]
    .filter(Boolean)
    .join(" · ");

  return `# ${title || taskId}\n\n${metadata}\n\n---\n\n${instruction}`;
}

function getDisplayItemStatus(
  status: BenchmarkAgentBatchItem["status"]
): BenchmarkAgentBatchItem["status"] {
  if (status === BENCHMARK_AGENT_BATCH_STATUS.LAUNCHED) {
    return BENCHMARK_AGENT_BATCH_STATUS.RUNNING;
  }
  return status;
}

function itemStatusColor(
  status: BenchmarkAgentBatchItem["status"],
  evaluationStatus?: BenchmarkAgentBatchItem["evaluationStatus"]
): string {
  if (evaluationStatus === BENCHMARK_RUN_STATUS.PASSED) {
    return "var(--color-success-6)";
  }
  if (evaluationStatus === BENCHMARK_RUN_STATUS.FAILED) {
    return "var(--color-danger-6)";
  }
  if (evaluationStatus === BENCHMARK_RUN_STATUS.RUNNING) {
    return "var(--color-primary-6)";
  }
  if (status === BENCHMARK_AGENT_BATCH_STATUS.RUNNING) {
    return "var(--color-primary-6)";
  }
  if (status === BENCHMARK_AGENT_BATCH_STATUS.FAILED) {
    return "var(--color-danger-6)";
  }
  if (status === BENCHMARK_AGENT_BATCH_STATUS.CANCELLED) {
    return "var(--color-warning-6)";
  }
  return "var(--color-fill-4)";
}

export const BenchmarkPanel: React.FC<BenchmarkPanelProps> = ({
  className,
  surface = "taskInfo",
  publishHeader = true,
}) => {
  const { t, i18n } = useTranslation(["sessions", "common"]);
  const batchStatus = useAtomValue(benchmarkAgentBatchStatusAtom);
  const sessions = useAtomValue(sessionsAtom);
  const [activeTaskId, setActiveTaskId] = useAtom(
    benchmarkActiveBatchTaskIdAtom
  );
  const setBenchmarkBatchStatus = useSetAtom(benchmarkAgentBatchStatusAtom);
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const setWorkstationActiveSessionId = useSetAtom(
    workstationActiveSessionIdAtom
  );
  const setChatPanelContentMode = useSetAtom(chatPanelContentModeAtom);
  const { refreshBatchStatus } = useBenchmarkAgentBatchRun();
  const [isEvaluatingBatch, setIsEvaluatingBatch] = useState(false);
  const [evaluationError, setEvaluationError] = useState<string | null>(null);
  const [evaluationNotice, setEvaluationNotice] = useState<string | null>(null);
  const [addTasksPanelOpen, setAddTasksPanelOpen] = useState(false);
  const [addTasksSearch, setAddTasksSearch] = useState("");
  const [addTaskIds, setAddTaskIds] = useState<string[]>([]);
  const [addTaskRows, setAddTaskRows] = useState<BenchmarkTaskIndexRow[]>([]);
  const [addTasksLoading, setAddTasksLoading] = useState(false);
  const [addTasksError, setAddTasksError] = useState<string | null>(null);
  const [collapsedAddTaskGroups, setCollapsedAddTaskGroups] = useState<
    Set<string>
  >(() => new Set());
  const [isUpdatingBatchTasks, setIsUpdatingBatchTasks] = useState(false);
  const [batchTaskActionError, setBatchTaskActionError] = useState<
    string | null
  >(null);
  const { error, isLoadingDetail, selectedTask, setSelectedTaskId } =
    useBenchmarkTasks({
      loadDetail: surface === "taskInfo",
      loadOnMount: false,
    });
  const [taskPreviewMode, setTaskPreviewMode] = useState(true);

  const activeItem = useMemo(
    () =>
      activeTaskId
        ? batchStatus?.items.find((item) => item.taskId === activeTaskId)
        : null,
    [activeTaskId, batchStatus?.items]
  );

  useEffect(() => {
    if (!addTasksPanelOpen || !batchStatus) {
      return;
    }
    const status = batchStatus;
    if (status.benchmarkKind !== BENCHMARK_KIND.SWE_BENCH_PRO) {
      setAddTaskRows([]);
      setAddTasksError(null);
      setAddTasksLoading(false);
      return;
    }
    let cancelled = false;
    async function loadAddTaskRows() {
      setAddTasksLoading(true);
      setAddTasksError(null);
      try {
        const rows = await listBenchmarkTasksShared({
          kind: status.benchmarkKind,
          sourcePath: status.sourcePath,
          limit: BENCHMARK_TASK_LIST_LIMIT,
        });
        if (cancelled) return;
        const existingTaskIds = new Set(
          status.items.map((item) => item.taskId)
        );
        setAddTaskRows(rows.filter((row) => !existingTaskIds.has(row.taskId)));
      } catch (error) {
        if (cancelled) return;
        setAddTasksError(
          error instanceof Error ? error.message : String(error)
        );
      } finally {
        if (!cancelled) {
          setAddTasksLoading(false);
        }
      }
    }
    void loadAddTaskRows();
    return () => {
      cancelled = true;
    };
  }, [addTasksPanelOpen, batchStatus]);

  useEffect(() => {
    if (surface !== "runList" || activeTaskId || !batchStatus?.items.length) {
      return;
    }
    const firstTaskId = batchStatus.items[0]?.taskId;
    if (!firstTaskId) {
      return;
    }
    setActiveTaskId(firstTaskId);
    setSelectedTaskId(firstTaskId);
  }, [
    activeTaskId,
    batchStatus?.items,
    setActiveTaskId,
    setSelectedTaskId,
    surface,
  ]);

  const markdownContent = useMemo(() => {
    if (!selectedTask) return "";
    return formatTaskMarkdown(
      selectedTask.taskId,
      selectedTask.title,
      selectedTask.repo,
      selectedTask.instruction
    );
  }, [selectedTask]);
  const handleToggleTaskPreview = useCallback(() => {
    setTaskPreviewMode((currentMode) => !currentMode);
  }, []);
  const headerPreviewToggle = useMemo(
    () => (
      <div className="flex h-7 shrink-0 items-center">
        <TabPill
          activeTab={taskPreviewMode ? "preview" : "source"}
          tabs={[
            {
              key: "source",
              label: t("common:common.raw"),
            },
            {
              key: "preview",
              label: t("common:common.preview"),
            },
          ]}
          onChange={(key) => {
            if (key === "preview" && !taskPreviewMode)
              handleToggleTaskPreview();
            if (key === "source" && taskPreviewMode) handleToggleTaskPreview();
          }}
          variant="pill"
          color="fill"
          fillWidth={false}
          size="small"
        />
      </div>
    ),
    [handleToggleTaskPreview, t, taskPreviewMode]
  );

  usePublishWorkstationTabHeader({
    host: "code",
    content: {
      trailing: headerPreviewToggle,
    },
    enabled: surface === "taskInfo" && publishHeader,
  });

  const handleSelectTask = useCallback(
    (item: BenchmarkAgentBatchItem) => {
      setActiveTaskId(item.taskId);
      setSelectedTaskId(item.taskId);
      if (!item.sessionId) {
        return;
      }
      setActiveSessionId(item.sessionId);
      setWorkstationActiveSessionId(item.sessionId);
      setChatPanelContentMode(CHAT_PANEL_CONTENT_MODE.SESSION);
      void loadSessions({ forceRefresh: true });
    },
    [
      setActiveSessionId,
      setActiveTaskId,
      setChatPanelContentMode,
      setSelectedTaskId,
      setWorkstationActiveSessionId,
    ]
  );

  const handleRefresh = useCallback(() => {
    void refreshBatchStatus().then((status) => {
      if (status) {
        setBenchmarkBatchStatus(status);
      }
    });
  }, [refreshBatchStatus, setBenchmarkBatchStatus]);

  const selectedBatchTaskActionIds = useMemo(
    () => (activeTaskId ? [activeTaskId] : []),
    [activeTaskId]
  );

  const updateBatchTasks = useCallback(
    async (action: BenchmarkBatchTaskAction, taskIds: string[]) => {
      if (!batchStatus?.batchId || taskIds.length === 0) return false;
      setIsUpdatingBatchTasks(true);
      setBatchTaskActionError(null);
      try {
        const status = await benchmarkApi.updateAgentBatchTasks({
          batchId: batchStatus.batchId,
          action,
          taskIds,
        });
        setBenchmarkAgentBatchStatusShared(status);
        setBenchmarkBatchStatus(status);
        void loadSessions({ forceRefresh: true });
        return true;
      } catch (error) {
        setBatchTaskActionError(
          error instanceof Error ? error.message : String(error)
        );
        return false;
      } finally {
        setIsUpdatingBatchTasks(false);
      }
    },
    [batchStatus?.batchId, setBenchmarkBatchStatus]
  );

  const handleUpdateSelectedBatchTasks = useCallback(
    async (action: BenchmarkBatchTaskAction) => {
      await updateBatchTasks(action, selectedBatchTaskActionIds);
    },
    [selectedBatchTaskActionIds, updateBatchTasks]
  );

  const handleAddSelectedBatchTasks = useCallback(async () => {
    const updated = await updateBatchTasks(
      BENCHMARK_BATCH_TASK_ACTION.ADD,
      addTaskIds
    );
    if (updated) {
      setAddTaskIds([]);
      setAddTasksPanelOpen(false);
    }
  }, [addTaskIds, updateBatchTasks]);

  const handleToggleAddTask = useCallback(
    (taskId: string, checked: boolean) => {
      setAddTaskIds((currentTaskIds) =>
        checked
          ? Array.from(new Set([...currentTaskIds, taskId]))
          : currentTaskIds.filter((currentTaskId) => currentTaskId !== taskId)
      );
    },
    []
  );

  const handleSelectAllAddTasks = useCallback(
    (checked: boolean, visibleTaskIds: string[]) => {
      setAddTaskIds((currentTaskIds) => {
        const visibleTaskIdSet = new Set(visibleTaskIds);
        return checked
          ? Array.from(new Set([...currentTaskIds, ...visibleTaskIds]))
          : currentTaskIds.filter((taskId) => !visibleTaskIdSet.has(taskId));
      });
    },
    []
  );

  const handleSelectAddTaskGroup = useCallback(
    (taskIds: string[], checked: boolean) => {
      setAddTaskIds((currentTaskIds) => {
        const groupTaskIdSet = new Set(taskIds);
        return checked
          ? Array.from(new Set([...currentTaskIds, ...taskIds]))
          : currentTaskIds.filter((taskId) => !groupTaskIdSet.has(taskId));
      });
    },
    []
  );

  const handleToggleAddTaskGroup = useCallback((repo: string) => {
    setCollapsedAddTaskGroups((currentGroups) => {
      const nextGroups = new Set(currentGroups);
      if (nextGroups.has(repo)) {
        nextGroups.delete(repo);
      } else {
        nextGroups.add(repo);
      }
      return nextGroups;
    });
  }, []);

  const handleToggleAllAddTaskGroups = useCallback((repos: string[]) => {
    setCollapsedAddTaskGroups((currentGroups) => {
      if (repos.length > 0 && repos.every((repo) => currentGroups.has(repo))) {
        return new Set();
      }
      return new Set(repos);
    });
  }, []);

  const handleToggleAddTasksPanel = useCallback(() => {
    setAddTasksPanelOpen((currentOpen) => !currentOpen);
  }, []);

  const handleCancelAddTasks = useCallback(() => {
    setAddTasksPanelOpen(false);
    setAddTaskIds([]);
  }, []);

  const handleEvaluateSubmittedPatches = useCallback(async () => {
    if (!batchStatus?.batchId) return;
    setIsEvaluatingBatch(true);
    setEvaluationError(null);
    setEvaluationNotice(null);
    try {
      const status = await benchmarkApi.evaluateAgentBatch({
        batchId: batchStatus.batchId,
        evaluationMode: BENCHMARK_EVALUATION_MODE.LOCAL_DOCKER,
      });
      setBenchmarkAgentBatchStatusShared(status);
      setBenchmarkBatchStatus(status);
      const evaluatedCount = status.items.filter(
        (item) => item.evaluationStatus
      ).length;
      const failedCount = status.items.filter(
        (item) => item.evaluationStatus === BENCHMARK_RUN_STATUS.FAILED
      ).length;
      setEvaluationNotice(
        `${t("creator.benchmark.evaluateSubmitted")}: ${evaluatedCount}/${status.items.length} · ${t("common:status.failed")}: ${failedCount}`
      );
    } catch (error) {
      setEvaluationError(
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      setIsEvaluatingBatch(false);
    }
  }, [batchStatus?.batchId, setBenchmarkBatchStatus, t]);

  const displayedRunningCount = batchStatus
    ? batchStatus.running + batchStatus.launched
    : 0;

  const sessionsById = useMemo(
    () => new Map(sessions.map((session) => [session.session_id, session])),
    [sessions]
  );
  const dateTimeLabelOptions = useMemo(
    () => ({
      todayLabel: t("common:relativeDate.today"),
      yesterdayLabel: t("common:relativeDate.yesterday"),
      locale: toIntlLocaleTag(i18n.resolvedLanguage),
    }),
    [i18n.resolvedLanguage, t]
  );
  const benchmarkSessionListItems = useMemo<SessionTableItem[]>(
    () =>
      batchStatus?.items.map((item) => {
        const displayStatus = getDisplayItemStatus(item.status);
        const session = item.sessionId
          ? sessionsById.get(item.sessionId)
          : undefined;
        const workspacePath = session?.worktreePath ?? session?.repoPath;
        const workspaceLabel = workspacePath
          ? (workspacePath.split(/[\\/]/).filter(Boolean).pop() ??
            workspacePath)
          : session?.repo_name;
        const modelLabel = session?.model
          ? formatModelNameFull(session.model)
          : undefined;

        const statusLabel = item.evaluationStatus
          ? `${displayStatus} · ${item.evaluationStatus}`
          : displayStatus;
        const evaluationLabel = item.evaluationStatus
          ? `${t("creator.benchmark.evaluateSubmitted")}: ${item.evaluationStatus}`
          : undefined;
        const rowDescription = item.evaluationError
          ? `${evaluationLabel ?? t("creator.benchmark.evaluateSubmitted")} · ${item.evaluationError}`
          : (evaluationLabel ?? item.error ?? undefined);

        return {
          id: item.taskId,
          title: item.taskId,
          description: rowDescription,
          statusLabel,
          statusColor: itemStatusColor(displayStatus, item.evaluationStatus),
          agentIcon: session?.cliAgentType ? (
            <ModelIcon agentType={session.cliAgentType} size={14} />
          ) : undefined,
          agentLabel: session?.agentDisplayName ?? session?.cliAgentType,
          modelIcon: session?.model ? (
            <ModelIcon
              modelName={session.model}
              agentType={session.cliAgentType}
              size={14}
            />
          ) : undefined,
          modelLabel,
          workspaceLabel,
          workspaceTitle: workspacePath,
          startedLabel: formatReplayDateLabel(
            item.startedAt ?? session?.created_at,
            {
              ...dateTimeLabelOptions,
              withSeconds: false,
              monthStyle: "short",
            }
          ),
          lastUpdatedLabel: formatReplayDateLabel(
            item.finishedAt ?? session?.updated_at ?? item.startedAt,
            {
              ...dateTimeLabelOptions,
              withSeconds: false,
              monthStyle: "short",
            }
          ),
          active: activeTaskId === item.taskId,
          testId: "benchmark-run-task-row",
          dataAttributes: {
            "data-benchmark-task-id": item.taskId,
            "data-benchmark-task-status": displayStatus,
            "data-benchmark-evaluation-status":
              item.evaluationStatus ?? undefined,
          },
        };
      }) ?? [],
    [activeTaskId, batchStatus?.items, dateTimeLabelOptions, sessionsById, t]
  );

  const handleSelectBenchmarkSessionListItem = useCallback(
    (listItem: SessionTableItem) => {
      const benchmarkItem = batchStatus?.items.find(
        (item) => item.taskId === listItem.id
      );
      if (!benchmarkItem) return;
      handleSelectTask(benchmarkItem);
    },
    [batchStatus?.items, handleSelectTask]
  );

  const taskDetailContent = useMemo(() => {
    if (error) {
      return (
        <Placeholder
          variant="error"
          placement="detail-panel"
          title={t("common:errors.failedToLoad")}
          subtitle={error}
          fillParentHeight
        />
      );
    }

    if (isLoadingDetail) {
      return (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          title={t("creator.benchmark.loading")}
          fillParentHeight
        />
      );
    }

    if (!selectedTask) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("creator.benchmark.selectTaskHint")}
          fillParentHeight
        />
      );
    }

    return (
      <div
        className="relative h-full min-h-0"
        data-testid="benchmark-run-task-detail"
      >
        {activeItem?.error ? (
          <div className="bg-fill-0 absolute left-4 right-4 top-3 z-10 rounded-lg border border-solid border-border-2 px-3 py-2 text-[12px] leading-5 text-danger-6 shadow-sm">
            {activeItem.error}
          </div>
        ) : null}
        {taskPreviewMode ? (
          <div className="markdown-preview-container scrollbar-overlay h-full min-h-0 overflow-y-auto p-6">
            <div className="allow-select-deep mx-auto max-w-[920px] select-text text-[13px] leading-6 text-text-2">
              <Markdown
                textContent={markdownContent}
                useChatCodeBlock
                skipPreprocess
              />
            </div>
          </div>
        ) : (
          <CodeMirrorEditor
            value={markdownContent}
            filePath="benchmark-task.md"
            height="100%"
            readOnly
            enableLinting={false}
            registerWithService={false}
          />
        )}
      </div>
    );
  }, [
    activeItem,
    error,
    isLoadingDetail,
    markdownContent,
    selectedTask,
    t,
    taskPreviewMode,
  ]);

  if (surface === "taskInfo") {
    return (
      <div
        className={`${className ?? ""} flex h-full min-h-0 flex-col overflow-hidden`}
      >
        {taskDetailContent}
      </div>
    );
  }

  const canEvaluateSubmittedPatches = Boolean(
    batchStatus?.items.some((item) => item.sessionId && item.submittedPatchPath)
  );
  const canUpdateSelectedBatchTasks =
    Boolean(batchStatus?.batchId) && selectedBatchTaskActionIds.length > 0;
  const runListSubtitle =
    batchTaskActionError ??
    evaluationError ??
    evaluationNotice ??
    t("creator.benchmark.sessionGroupProgress", {
      total: batchStatus?.totalTasks ?? 0,
      queued: batchStatus?.queued ?? 0,
      running: displayedRunningCount,
      launched: 0,
      failed: batchStatus?.failed ?? 0,
      cancelled: batchStatus?.cancelled ?? 0,
    });
  const batchTaskToolbar = (
    <div className="flex w-full min-w-0 flex-col gap-2">
      <div className="flex w-full min-w-0 items-center justify-end gap-2">
        <Button
          htmlType="button"
          size="small"
          variant={addTasksPanelOpen ? "primary" : "secondary"}
          disabled={isUpdatingBatchTasks}
          onClick={handleToggleAddTasksPanel}
          data-testid="benchmark-batch-add-tasks-toggle"
        >
          {t("common:actions.add")}
        </Button>
        <Button
          htmlType="button"
          size="small"
          variant="secondary"
          disabled={isUpdatingBatchTasks || !canUpdateSelectedBatchTasks}
          onClick={() =>
            void handleUpdateSelectedBatchTasks(
              BENCHMARK_BATCH_TASK_ACTION.REMOVE
            )
          }
          data-testid="benchmark-batch-remove-tasks"
        >
          {t("common:actions.remove")}
        </Button>
        <Button
          htmlType="button"
          size="small"
          variant="secondary"
          disabled={isUpdatingBatchTasks || !canUpdateSelectedBatchTasks}
          onClick={() =>
            void handleUpdateSelectedBatchTasks(
              BENCHMARK_BATCH_TASK_ACTION.CANCEL
            )
          }
          data-testid="benchmark-batch-cancel-tasks"
        >
          {t("common:actions.stop")}
        </Button>
        <Button
          htmlType="button"
          size="small"
          variant="primary"
          disabled={isUpdatingBatchTasks || !canUpdateSelectedBatchTasks}
          onClick={() =>
            void handleUpdateSelectedBatchTasks(
              BENCHMARK_BATCH_TASK_ACTION.RESTART
            )
          }
          data-testid="benchmark-batch-restart-tasks"
        >
          {t("common:actions.restart")}
        </Button>
      </div>
      {addTasksPanelOpen && batchStatus ? (
        <div
          className={`flex w-full flex-col gap-3 rounded-[12px] border border-solid border-border-2 p-3 ${SURFACE_TOKENS.surface}`}
        >
          <div className="grid grid-cols-2 gap-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="text-[13px] font-semibold text-text-1">
                {t("creator.benchmark.kindTitle")}
              </div>
              <Input
                value={t(
                  `creator.benchmark.kinds.${
                    batchStatus.benchmarkKind === BENCHMARK_KIND.TERMINAL_BENCH
                      ? "terminalBench"
                      : "sweBenchPro"
                  }`
                )}
                onChange={() => undefined}
                size="small"
                className="w-full"
                disabled
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="text-[13px] font-semibold text-text-1">
                {t("creator.benchmark.workingDirectory")}
              </div>
              <Input
                value={batchStatus.launch?.workspacePath ?? ""}
                onChange={() => undefined}
                size="small"
                className="w-full"
                disabled
              />
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-1.5 border-t border-solid border-border-2 pt-3">
            <div className="text-[13px] font-semibold text-text-1">
              {t("creator.benchmark.sourcePath")} (
              {t("creator.benchmark.localPath")})
            </div>
            <Input
              value={batchStatus.sourcePath}
              onChange={() => undefined}
              size="small"
              className="w-full"
              disabled
            />
          </div>
          <BenchmarkTaskSelector
            className="border-t border-solid border-border-2 pt-3"
            tasks={addTaskRows}
            selectedTaskIds={addTaskIds}
            searchValue={addTasksSearch}
            collapsedGroups={collapsedAddTaskGroups}
            isLoading={addTasksLoading}
            canLoadTasks={
              batchStatus.benchmarkKind === BENCHMARK_KIND.SWE_BENCH_PRO
            }
            error={addTasksError}
            onSearchChange={setAddTasksSearch}
            onToggleTask={handleToggleAddTask}
            onSelectAllVisible={handleSelectAllAddTasks}
            onSelectGroup={handleSelectAddTaskGroup}
            onToggleGroup={handleToggleAddTaskGroup}
            onToggleAllGroups={handleToggleAllAddTaskGroups}
          />
          <div className="flex items-center justify-end gap-2 border-t border-solid border-border-2 pt-3">
            <Button
              htmlType="button"
              size="small"
              variant="secondary"
              disabled={isUpdatingBatchTasks}
              onClick={handleCancelAddTasks}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              htmlType="button"
              size="small"
              variant="primary"
              disabled={
                isUpdatingBatchTasks ||
                addTaskIds.length === 0 ||
                addTasksLoading
              }
              onClick={() => void handleAddSelectedBatchTasks()}
              data-testid="benchmark-batch-add-selected-tasks"
            >
              {t("common:actions.add")}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );

  if (!batchStatus) {
    return (
      <div
        className={`${className ?? ""} flex h-full min-h-0 flex-col overflow-hidden`}
        data-testid="benchmark-run-page"
      >
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("creator.benchmark.noSessionYet")}
          fillParentHeight
        />
      </div>
    );
  }

  return (
    <SessionGroupPage
      className={className}
      testId="benchmark-run-page"
      headerTestId="benchmark-run-header"
      listTestId="benchmark-run-task-list"
      dataAttributes={{
        "data-benchmark-batch-id": batchStatus.batchId,
        "data-benchmark-status": batchStatus.status,
      }}
      title={t("creator.benchmark.sessionGroupTitle")}
      subtitle={runListSubtitle}
      items={benchmarkSessionListItems}
      onSelectItem={handleSelectBenchmarkSessionListItem}
      toolbar={batchTaskToolbar}
      actions={[
        {
          label: t("creator.benchmark.evaluateSubmitted"),
          onClick: handleEvaluateSubmittedPatches,
          variant: "primary",
          disabled: isEvaluatingBatch || !canEvaluateSubmittedPatches,
          testId: "benchmark-evaluate-submitted-patches",
        },
        {
          label: t("common:actions.refresh"),
          onClick: handleRefresh,
        },
      ]}
    />
  );
};
