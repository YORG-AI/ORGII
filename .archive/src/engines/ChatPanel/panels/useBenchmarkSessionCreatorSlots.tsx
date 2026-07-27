import { open } from "@tauri-apps/plugin-dialog";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  CheckCircle2,
  Clipboard,
  FolderOpen,
  TriangleAlert,
  X,
} from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  BENCHMARK_AGENT_BATCH_STATUS,
  BENCHMARK_EVALUATION_MODE,
  BENCHMARK_KIND,
  BENCHMARK_RUN_TYPE,
  type BenchmarkEvaluationMode,
} from "@src/api/tauri/benchmark";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Select, { type SelectOption } from "@src/components/Select";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import BenchmarkTaskSelector from "@src/features/BenchmarkPanel/BenchmarkTaskSelector";
import { useBenchmarkAgentBatchRun } from "@src/hooks/benchmark/useBenchmarkAgentBatchRun";
import { useBenchmarkRun } from "@src/hooks/benchmark/useBenchmarkRun";
import { useBenchmarkTasks } from "@src/hooks/benchmark/useBenchmarkTasks";
import {
  benchmarkActiveBatchTaskIdAtom,
  benchmarkAgentBatchErrorAtom,
  benchmarkBatchConcurrencyAtom,
  benchmarkBatchSelectedTaskIdsAtom,
  benchmarkRunTypeAtom,
  benchmarkWorkingDirectoryAtom,
} from "@src/store/benchmark";

interface UseBenchmarkSessionCreatorSlotsOptions {
  enabled: boolean;
  onOpenBenchmarkTab: () => void;
}

interface BenchmarkSessionCreatorSlots {
  bodySlot: React.ReactNode;
  footerSlot: React.ReactNode;
}

export function useBenchmarkSessionCreatorSlots({
  enabled,
  onOpenBenchmarkTab,
}: UseBenchmarkSessionCreatorSlotsOptions): BenchmarkSessionCreatorSlots {
  const { t } = useTranslation(["sessions", "common"]);
  const [benchmarkRunType, setBenchmarkRunType] = useAtom(benchmarkRunTypeAtom);
  const [selectedBatchTaskIds, setSelectedBatchTaskIds] = useAtom(
    benchmarkBatchSelectedTaskIdsAtom
  );
  const [benchmarkBatchConcurrency, setBenchmarkBatchConcurrency] = useAtom(
    benchmarkBatchConcurrencyAtom
  );
  const [benchmarkWorkingDirectory, setBenchmarkWorkingDirectory] = useAtom(
    benchmarkWorkingDirectoryAtom
  );
  const benchmarkAgentBatchError = useAtomValue(benchmarkAgentBatchErrorAtom);
  const setActiveBatchTaskId = useSetAtom(benchmarkActiveBatchTaskIdAtom);
  const [benchmarkTaskSearch, setBenchmarkTaskSearch] = useState("");
  const [benchmarkPreflightDismissed, setBenchmarkPreflightDismissed] =
    useState(false);
  const [collapsedBenchmarkTaskGroups, setCollapsedBenchmarkTaskGroups] =
    useState<Set<string>>(() => new Set());
  const {
    error: benchmarkError,
    isLoadingTasks: isLoadingBenchmarkTasks,
    kind: benchmarkKind,
    loadTasks: loadBenchmarkTasks,
    selectedTaskId: selectedBenchmarkTaskId,
    setKind: setBenchmarkKind,
    setSelectedTaskId: setSelectedBenchmarkTaskId,
    setSourcePath: setBenchmarkSourcePath,
    sourcePath: benchmarkSourcePath,
    tasks: benchmarkTasks,
  } = useBenchmarkTasks({
    loadDetail: false,
    loadOnMount: enabled,
  });
  const {
    evaluationMode: benchmarkEvaluationMode,
    isRunLoading: isBenchmarkRunLoading,
    preflight: benchmarkPreflight,
    refreshPreflight: refreshBenchmarkPreflight,
    runError: benchmarkRunError,
    setEvaluationMode: setBenchmarkEvaluationMode,
    setTargetRepoPath: setBenchmarkTargetRepoPath,
    targetRepoPath: benchmarkTargetRepoPath,
  } = useBenchmarkRun();
  const {
    batchStatus: benchmarkAgentBatchStatus,
    cancelBatch: cancelBenchmarkAgentBatch,
    isBatchLoading: isBenchmarkAgentBatchLoading,
    startBatch: startBenchmarkAgentBatch,
    taskIdsForLaunch: benchmarkTaskIdsForLaunch,
  } = useBenchmarkAgentBatchRun();

  const benchmarkKindOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: BENCHMARK_KIND.SWE_BENCH_PRO,
        label: t("creator.benchmark.kinds.sweBenchPro"),
      },
      {
        value: BENCHMARK_KIND.TERMINAL_BENCH,
        label: t("creator.benchmark.kinds.terminalBench"),
      },
    ],
    [t]
  );

  const benchmarkRunTypeOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: BENCHMARK_RUN_TYPE.SINGLE,
        label: t("creator.benchmark.singleRun"),
      },
      {
        value: BENCHMARK_RUN_TYPE.BATCH,
        label: t("creator.benchmark.batchRun"),
      },
    ],
    [t]
  );

  const benchmarkEvaluationModeOptions = useMemo<SelectOption[]>(
    () => [
      {
        value: BENCHMARK_EVALUATION_MODE.LOCAL_DOCKER,
        label: t("creator.benchmark.localDocker"),
      },
      {
        value: BENCHMARK_EVALUATION_MODE.PATCH_ONLY,
        label: t("creator.benchmark.patchOnlyWorktree"),
      },
    ],
    [t]
  );

  const isBenchmarkPatchOnlyMode =
    benchmarkEvaluationMode === BENCHMARK_EVALUATION_MODE.PATCH_ONLY;
  const canLoadBenchmarkTasks = benchmarkKind === BENCHMARK_KIND.SWE_BENCH_PRO;
  const isBenchmarkAgentBatchRunning =
    benchmarkAgentBatchStatus?.status === BENCHMARK_AGENT_BATCH_STATUS.RUNNING;
  const benchmarkPreflightReadyCount =
    benchmarkPreflight?.checks.filter((check) => check.ok).length ?? 0;
  const benchmarkPreflightTotalCount = benchmarkPreflight?.checks.length ?? 0;
  const benchmarkPreflightChecks = benchmarkPreflight?.checks ?? [];
  const benchmarkPreflightReadyChecks = benchmarkPreflightChecks.filter(
    (check) => check.ok
  );
  const benchmarkPreflightNeedsSetupChecks = benchmarkPreflightChecks.filter(
    (check) => !check.ok
  );
  const benchmarkPreflightStatusClass = benchmarkPreflight?.ready
    ? "text-success-6"
    : "text-warning-6";
  const benchmarkPreflightSummary = benchmarkPreflight
    ? t("creator.benchmark.preflightSummary", {
        ready: benchmarkPreflightReadyCount,
        total: benchmarkPreflightTotalCount,
      })
    : t("creator.benchmark.preflightTitle");
  const benchmarkPreflightCopyText = useMemo(() => {
    const lines: string[] = [benchmarkPreflightSummary];
    if (benchmarkPreflightNeedsSetupChecks.length > 0) {
      lines.push("", t("creator.benchmark.needsSetup"));
      lines.push(
        ...benchmarkPreflightNeedsSetupChecks.map((check) =>
          check.detail ? `${check.label}: ${check.detail}` : check.label
        )
      );
    }
    if (benchmarkPreflightReadyChecks.length > 0) {
      lines.push("", t("creator.benchmark.ready"));
      lines.push(
        ...benchmarkPreflightReadyChecks.map((check) =>
          check.detail ? `${check.label}: ${check.detail}` : check.label
        )
      );
    }
    return lines.join("\n");
  }, [
    benchmarkPreflightNeedsSetupChecks,
    benchmarkPreflightReadyChecks,
    benchmarkPreflightSummary,
    t,
  ]);

  const handleBenchmarkKindChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (typeof value !== "string") {
        return;
      }
      if (
        value !== BENCHMARK_KIND.SWE_BENCH_PRO &&
        value !== BENCHMARK_KIND.TERMINAL_BENCH
      ) {
        return;
      }
      setBenchmarkKind(value);
      setSelectedBenchmarkTaskId(null);
    },
    [setBenchmarkKind, setSelectedBenchmarkTaskId]
  );

  const handleBenchmarkRunTypeChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (typeof value !== "string") {
        return;
      }
      if (
        value === BENCHMARK_RUN_TYPE.SINGLE ||
        value === BENCHMARK_RUN_TYPE.BATCH
      ) {
        setBenchmarkRunType(value);
      }
    },
    [setBenchmarkRunType]
  );

  const handleBenchmarkTaskToggle = useCallback(
    (taskId: string, checked: boolean) => {
      setSelectedBatchTaskIds((currentTaskIds) => {
        const nextTaskIds = checked
          ? Array.from(new Set([...currentTaskIds, taskId]))
          : currentTaskIds.filter((currentTaskId) => currentTaskId !== taskId);
        setSelectedBenchmarkTaskId(checked ? taskId : (nextTaskIds[0] ?? null));
        setActiveBatchTaskId(checked ? taskId : (nextTaskIds[0] ?? null));
        return nextTaskIds;
      });
    },
    [setActiveBatchTaskId, setSelectedBatchTaskIds, setSelectedBenchmarkTaskId]
  );

  const handleBenchmarkSelectAllTasks = useCallback(
    (checked: boolean, visibleTaskIds: string[]) => {
      setSelectedBatchTaskIds((currentTaskIds) => {
        const visibleTaskIdSet = new Set(visibleTaskIds);
        const nextTaskIds = checked
          ? Array.from(new Set([...currentTaskIds, ...visibleTaskIds]))
          : currentTaskIds.filter((taskId) => !visibleTaskIdSet.has(taskId));
        setSelectedBenchmarkTaskId(nextTaskIds[0] ?? null);
        setActiveBatchTaskId(nextTaskIds[0] ?? null);
        return nextTaskIds;
      });
    },
    [setActiveBatchTaskId, setSelectedBatchTaskIds, setSelectedBenchmarkTaskId]
  );

  const handleBenchmarkSelectGroupTasks = useCallback(
    (taskIds: string[], checked: boolean) => {
      setSelectedBatchTaskIds((currentTaskIds) => {
        const groupTaskIdSet = new Set(taskIds);
        const nextTaskIds = checked
          ? Array.from(new Set([...currentTaskIds, ...taskIds]))
          : currentTaskIds.filter((taskId) => !groupTaskIdSet.has(taskId));
        setSelectedBenchmarkTaskId(nextTaskIds[0] ?? null);
        setActiveBatchTaskId(nextTaskIds[0] ?? null);
        return nextTaskIds;
      });
    },
    [setActiveBatchTaskId, setSelectedBatchTaskIds, setSelectedBenchmarkTaskId]
  );

  const handleBenchmarkToggleGroup = useCallback((repo: string) => {
    setCollapsedBenchmarkTaskGroups((currentGroups) => {
      const nextGroups = new Set(currentGroups);
      if (nextGroups.has(repo)) {
        nextGroups.delete(repo);
      } else {
        nextGroups.add(repo);
      }
      return nextGroups;
    });
  }, []);

  const handleBenchmarkToggleAllGroups = useCallback((repos: string[]) => {
    setCollapsedBenchmarkTaskGroups((currentGroups) => {
      if (repos.length > 0 && repos.every((repo) => currentGroups.has(repo))) {
        return new Set();
      }
      return new Set(repos);
    });
  }, []);

  const handleBenchmarkLoadTasks = useCallback(() => {
    void loadBenchmarkTasks();
  }, [loadBenchmarkTasks]);

  const handleBenchmarkPickSourceFolder = useCallback(async () => {
    const selected = await open({
      multiple: false,
      directory: true,
      title: t("creator.benchmark.sourcePath"),
    });
    if (typeof selected === "string") {
      setBenchmarkSourcePath(selected);
    }
  }, [setBenchmarkSourcePath, t]);

  const handleBenchmarkPickWorkingDirectory = useCallback(async () => {
    const selected = await open({
      multiple: false,
      directory: true,
      title: t("creator.benchmark.workingDirectory"),
    });
    if (typeof selected === "string") {
      setBenchmarkWorkingDirectory(selected);
    }
  }, [setBenchmarkWorkingDirectory, t]);

  const handleBenchmarkEvaluationModeChange = useCallback(
    (value: string | number | (string | number)[]) => {
      if (typeof value === "string") {
        setBenchmarkEvaluationMode(value as BenchmarkEvaluationMode);
      }
    },
    [setBenchmarkEvaluationMode]
  );

  const handleBenchmarkPreflight = useCallback(() => {
    setBenchmarkPreflightDismissed(false);
    void refreshBenchmarkPreflight();
  }, [refreshBenchmarkPreflight]);

  const handleBenchmarkConcurrencyChange = useCallback(
    (value: string) => {
      const nextValue = Number.parseInt(value, 10);
      if (Number.isNaN(nextValue)) {
        setBenchmarkBatchConcurrency(1);
        return;
      }
      setBenchmarkBatchConcurrency(Math.min(Math.max(nextValue, 1), 8));
    },
    [setBenchmarkBatchConcurrency]
  );

  const handleBenchmarkStartBatch = useCallback(() => {
    void startBenchmarkAgentBatch();
  }, [startBenchmarkAgentBatch]);

  const handleBenchmarkCancelBatch = useCallback(() => {
    void cancelBenchmarkAgentBatch();
  }, [cancelBenchmarkAgentBatch]);

  const handleCopyBenchmarkPreflight = useCallback(() => {
    void navigator.clipboard.writeText(benchmarkPreflightCopyText);
  }, [benchmarkPreflightCopyText]);

  const handleCloseBenchmarkPreflight = useCallback(() => {
    setBenchmarkPreflightDismissed(true);
  }, []);

  const bodySlot = enabled ? (
    <>
      <div
        id="session-creator-benchmark-panel"
        className={`flex w-full flex-col gap-3 rounded-[12px] border border-solid border-border-2 p-3 ${SURFACE_TOKENS.surface}`}
      >
        <div className="grid grid-cols-2 gap-2">
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="text-[13px] font-semibold text-text-1">
              {t("creator.benchmark.kindTitle")}
            </div>
            <Select
              value={benchmarkKind}
              options={benchmarkKindOptions}
              onChange={handleBenchmarkKindChange}
              size="small"
              radius="lg"
              className="w-full"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="text-[13px] font-semibold text-text-1">
              {t("creator.benchmark.runType")}
            </div>
            <Select
              value={benchmarkRunType}
              options={benchmarkRunTypeOptions}
              onChange={handleBenchmarkRunTypeChange}
              size="small"
              radius="lg"
              className="w-full"
            />
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t border-solid border-border-2 pt-3">
          <div className="text-[13px] font-semibold text-text-1">
            {t("creator.benchmark.sourcePath")} (
            {t("creator.benchmark.localPath")})
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={benchmarkSourcePath}
              onChange={setBenchmarkSourcePath}
              placeholder={t("creator.benchmark.sourcePathPlaceholder")}
              size="small"
              className="min-w-0 flex-1"
              allowClear
            />
            <Button
              htmlType="button"
              variant="secondary"
              size="small"
              iconOnly
              icon={<FolderOpen size={14} strokeWidth={1.75} />}
              title={t("common:actions.browse")}
              aria-label={t("common:actions.browse")}
              onClick={handleBenchmarkPickSourceFolder}
            />
            <Button
              htmlType="button"
              variant="primary"
              size="small"
              onClick={handleBenchmarkLoadTasks}
              disabled={
                isLoadingBenchmarkTasks ||
                !benchmarkSourcePath.trim() ||
                !canLoadBenchmarkTasks
              }
            >
              {t("common:actions.load")}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-[13px] font-semibold text-text-1">
            {t("creator.benchmark.workingDirectory")}
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={benchmarkWorkingDirectory}
              onChange={setBenchmarkWorkingDirectory}
              placeholder={t("creator.benchmark.workingDirectoryPlaceholder")}
              size="small"
              className="min-w-0 flex-1"
              allowClear
            />
            <Button
              htmlType="button"
              variant="secondary"
              size="small"
              iconOnly
              icon={<FolderOpen size={14} strokeWidth={1.75} />}
              title={t("common:actions.browse")}
              aria-label={t("common:actions.browse")}
              onClick={handleBenchmarkPickWorkingDirectory}
            />
          </div>
        </div>

        <BenchmarkTaskSelector
          className="border-t border-solid border-border-2 pt-3"
          tasks={benchmarkTasks}
          selectedTaskIds={selectedBatchTaskIds}
          searchValue={benchmarkTaskSearch}
          collapsedGroups={collapsedBenchmarkTaskGroups}
          isLoading={isLoadingBenchmarkTasks}
          canLoadTasks={canLoadBenchmarkTasks}
          error={benchmarkError}
          onSearchChange={setBenchmarkTaskSearch}
          onToggleTask={handleBenchmarkTaskToggle}
          onSelectAllVisible={handleBenchmarkSelectAllTasks}
          onSelectGroup={handleBenchmarkSelectGroupTasks}
          onToggleGroup={handleBenchmarkToggleGroup}
          onToggleAllGroups={handleBenchmarkToggleAllGroups}
        />

        <div className="flex flex-col gap-2 border-t border-solid border-border-2 pt-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="text-[13px] font-semibold text-text-1">
                {t("creator.benchmark.evaluationModeTitle")}
              </div>
              <Select
                value={benchmarkEvaluationMode}
                options={benchmarkEvaluationModeOptions}
                onChange={handleBenchmarkEvaluationModeChange}
                size="small"
                radius="lg"
                className="w-full"
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1.5">
              <div className="text-[13px] font-semibold text-text-1">
                {t("creator.benchmark.concurrency")}
              </div>
              <Input
                value={String(benchmarkBatchConcurrency)}
                onChange={handleBenchmarkConcurrencyChange}
                size="small"
                className="w-full"
              />
            </div>
          </div>
          {isBenchmarkPatchOnlyMode && (
            <Input
              value={benchmarkTargetRepoPath}
              onChange={setBenchmarkTargetRepoPath}
              placeholder={t("creator.benchmark.targetRepoPathPlaceholder")}
              size="small"
              allowClear
            />
          )}
        </div>
      </div>

      {!benchmarkPreflightDismissed &&
        (benchmarkAgentBatchError ||
          benchmarkRunError ||
          benchmarkPreflightChecks.length > 0) && (
          <div
            id="session-creator-benchmark-preflight-panel"
            className={`allow-select-deep flex w-full flex-col rounded-[12px] border border-solid border-border-2 text-left text-[12px] leading-5 ${SURFACE_TOKENS.surface}`}
          >
            {benchmarkAgentBatchError ? (
              <div className="allow-select-deep scrollbar-overlay max-h-24 w-full overflow-y-auto break-words rounded-lg border border-solid border-danger-3 px-3 py-2 text-left text-[12px] leading-5 text-danger-6">
                {benchmarkAgentBatchError}
              </div>
            ) : benchmarkRunError ? (
              <div className="allow-select-deep scrollbar-overlay max-h-24 w-full overflow-y-auto break-words rounded-lg border border-solid border-danger-3 px-3 py-2 text-left text-[12px] leading-5 text-danger-6">
                {benchmarkRunError}
              </div>
            ) : benchmarkPreflightChecks.length > 0 ? (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b border-solid border-border-2 px-3 py-2">
                  <div
                    className={`min-w-0 flex-1 font-medium ${benchmarkPreflightStatusClass}`}
                  >
                    {benchmarkPreflightSummary}
                  </div>
                  <Button
                    htmlType="button"
                    variant="tertiary"
                    size="small"
                    iconOnly
                    icon={<Clipboard size={13} strokeWidth={1.8} />}
                    title={t("common:actions.copy")}
                    aria-label={t("common:actions.copy")}
                    onClick={handleCopyBenchmarkPreflight}
                  />
                  <Button
                    htmlType="button"
                    variant="tertiary"
                    size="small"
                    iconOnly
                    icon={<X size={13} strokeWidth={1.8} />}
                    title={t("common:actions.close")}
                    aria-label={t("common:actions.close")}
                    onClick={handleCloseBenchmarkPreflight}
                  />
                </div>
                <div className="flex flex-col gap-2 px-3 py-2">
                  {benchmarkPreflightNeedsSetupChecks.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5 font-medium text-warning-6">
                        <TriangleAlert size={13} strokeWidth={1.8} />
                        {t("creator.benchmark.needsSetup")}
                      </div>
                      <div className="flex flex-col gap-0.5 pl-[19px] text-warning-6">
                        {benchmarkPreflightNeedsSetupChecks.map((check) => (
                          <div key={check.id} className="break-words">
                            {check.detail
                              ? `${check.label}: ${check.detail}`
                              : check.label}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {benchmarkPreflightReadyChecks.length > 0 && (
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-1.5 font-medium text-success-6">
                        <CheckCircle2 size={13} strokeWidth={1.8} />
                        {t("creator.benchmark.ready")}
                      </div>
                      <div className="flex flex-col gap-0.5 pl-[19px] text-success-6">
                        {benchmarkPreflightReadyChecks.map((check) => (
                          <div key={check.id} className="break-words">
                            {check.detail
                              ? `${check.label}: ${check.detail}`
                              : check.label}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </div>
        )}
    </>
  ) : null;

  const footerSlot = enabled ? (
    <>
      <Button
        htmlType="button"
        variant="secondary"
        size="small"
        onClick={onOpenBenchmarkTab}
      >
        {t("creator.benchmark.openWorkstationTab")}
      </Button>
      <Button
        htmlType="button"
        variant="secondary"
        size="small"
        onClick={handleBenchmarkPreflight}
        disabled={
          isBenchmarkRunLoading ||
          (canLoadBenchmarkTasks && !selectedBenchmarkTaskId)
        }
      >
        {t("creator.benchmark.runPreflight")}
      </Button>
      {isBenchmarkAgentBatchRunning ? (
        <Button
          htmlType="button"
          variant="secondary"
          size="small"
          onClick={handleBenchmarkCancelBatch}
          disabled={isBenchmarkAgentBatchLoading}
        >
          {t("common:actions.cancel")}
        </Button>
      ) : (
        <Button
          htmlType="button"
          variant="primary"
          size="small"
          onClick={handleBenchmarkStartBatch}
          disabled={
            isBenchmarkAgentBatchLoading ||
            isLoadingBenchmarkTasks ||
            !canLoadBenchmarkTasks ||
            !benchmarkSourcePath.trim() ||
            !benchmarkWorkingDirectory.trim() ||
            benchmarkTaskIdsForLaunch.length === 0
          }
        >
          {t("creator.start")}
        </Button>
      )}
    </>
  ) : null;

  return { bodySlot, footerSlot };
}
