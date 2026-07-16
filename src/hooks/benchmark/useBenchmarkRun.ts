import { useAtom, useAtomValue } from "jotai";
import { useCallback } from "react";

import {
  BENCHMARK_EVALUATION_MODE,
  BENCHMARK_RUN_STATUS,
  benchmarkApi,
} from "@src/api/tauri/benchmark";
import { useVisiblePolling } from "@src/hooks/async";
import {
  benchmarkEvaluationModeAtom,
  benchmarkKindAtom,
  benchmarkPatchTextAtom,
  benchmarkPreflightAtom,
  benchmarkRunErrorAtom,
  benchmarkRunLoadingAtom,
  benchmarkRunPlanAtom,
  benchmarkRunStatusAtom,
  benchmarkSelectedTaskIdAtom,
  benchmarkSourcePathAtom,
  benchmarkTargetRepoPathAtom,
} from "@src/store/benchmark";

const RUN_STATUS_POLL_INTERVAL_MS = 2_000;

export function useBenchmarkRun() {
  const kind = useAtomValue(benchmarkKindAtom);
  const sourcePath = useAtomValue(benchmarkSourcePathAtom);
  const selectedTaskId = useAtomValue(benchmarkSelectedTaskIdAtom);
  const [evaluationMode, setEvaluationMode] = useAtom(
    benchmarkEvaluationModeAtom
  );
  const [targetRepoPath, setTargetRepoPath] = useAtom(
    benchmarkTargetRepoPathAtom
  );
  const [patchText, setPatchText] = useAtom(benchmarkPatchTextAtom);
  const [preflight, setPreflight] = useAtom(benchmarkPreflightAtom);
  const [runPlan, setRunPlan] = useAtom(benchmarkRunPlanAtom);
  const [runStatus, setRunStatus] = useAtom(benchmarkRunStatusAtom);
  const [isRunLoading, setIsRunLoading] = useAtom(benchmarkRunLoadingAtom);
  const [runError, setRunError] = useAtom(benchmarkRunErrorAtom);

  const refreshPreflight = useCallback(async () => {
    setRunError(null);
    const result = await benchmarkApi.preflight({
      kind,
      sourcePath,
      evaluationMode,
      taskId: selectedTaskId ?? undefined,
      repoPath:
        evaluationMode === BENCHMARK_EVALUATION_MODE.PATCH_ONLY
          ? targetRepoPath
          : undefined,
    });
    setPreflight(result);
    return result;
  }, [
    evaluationMode,
    kind,
    selectedTaskId,
    setPreflight,
    setRunError,
    sourcePath,
    targetRepoPath,
  ]);

  const createRunPlan = useCallback(async () => {
    if (!selectedTaskId) {
      throw new Error("Select a benchmark task before creating a run plan.");
    }
    setIsRunLoading(true);
    setRunError(null);
    try {
      const plan = await benchmarkApi.createRunPlan({
        kind,
        sourcePath,
        taskId: selectedTaskId,
        patch: patchText,
        evaluationMode,
        repoPath:
          evaluationMode === BENCHMARK_EVALUATION_MODE.PATCH_ONLY
            ? targetRepoPath
            : undefined,
      });
      setRunPlan(plan);
      setPreflight(plan.preflight);
      return plan;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRunError(message);
      throw error;
    } finally {
      setIsRunLoading(false);
    }
  }, [
    evaluationMode,
    kind,
    patchText,
    selectedTaskId,
    setIsRunLoading,
    setPreflight,
    setRunError,
    setRunPlan,
    sourcePath,
    targetRepoPath,
  ]);

  const startRun = useCallback(async () => {
    if (!selectedTaskId) {
      throw new Error(
        "Select a benchmark task before starting a benchmark run."
      );
    }
    setIsRunLoading(true);
    setRunError(null);
    try {
      const status = await benchmarkApi.startRun({
        kind,
        sourcePath,
        taskId: selectedTaskId,
        patch: patchText,
        evaluationMode,
        repoPath:
          evaluationMode === BENCHMARK_EVALUATION_MODE.PATCH_ONLY
            ? targetRepoPath
            : undefined,
      });
      setRunStatus(status);
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRunError(message);
      throw error;
    } finally {
      setIsRunLoading(false);
    }
  }, [
    evaluationMode,
    kind,
    patchText,
    selectedTaskId,
    setIsRunLoading,
    setRunError,
    setRunStatus,
    sourcePath,
    targetRepoPath,
  ]);

  const cancelRun = useCallback(async () => {
    if (!runStatus?.runId) return;
    setIsRunLoading(true);
    setRunError(null);
    try {
      const status = await benchmarkApi.cancelRun({ runId: runStatus.runId });
      setRunStatus(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRunError(message);
    } finally {
      setIsRunLoading(false);
    }
  }, [runStatus?.runId, setIsRunLoading, setRunError, setRunStatus]);

  const pollRunStatus = useCallback(
    async (signal: AbortSignal) => {
      if (!runStatus?.runId) return false;
      try {
        const status = await benchmarkApi.getRunStatus({
          runId: runStatus.runId,
        });
        if (signal.aborted) return false;
        setRunStatus(status);
        setRunError(null);
        return status.status === BENCHMARK_RUN_STATUS.RUNNING;
      } catch (error) {
        if (signal.aborted) return false;
        setRunError(error instanceof Error ? error.message : String(error));
        return true;
      }
    },
    [runStatus?.runId, setRunError, setRunStatus]
  );

  useVisiblePolling({
    enabled:
      !!runStatus?.runId && runStatus.status === BENCHMARK_RUN_STATUS.RUNNING,
    intervalMs: RUN_STATUS_POLL_INTERVAL_MS,
    poll: pollRunStatus,
    immediate: false,
  });

  return {
    cancelRun,
    createRunPlan,
    evaluationMode,
    isRunLoading,
    patchText,
    preflight,
    refreshPreflight,
    runError,
    runPlan,
    runStatus,
    setEvaluationMode,
    setPatchText,
    setTargetRepoPath,
    startRun,
    targetRepoPath,
  };
}
