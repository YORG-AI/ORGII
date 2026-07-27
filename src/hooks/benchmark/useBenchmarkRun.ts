import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect } from "react";

import {
  BENCHMARK_EVALUATION_MODE,
  BENCHMARK_RUN_STATUS,
  benchmarkApi,
} from "@src/api/tauri/benchmark";
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
import { startVisibilityAwarePoll } from "@src/util/core/visibilityAwarePoll";

import {
  getBenchmarkRunStatusShared,
  setBenchmarkRunStatusShared,
} from "./benchmarkRequestCoordinator";

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
      setBenchmarkRunStatusShared(status);
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
      setBenchmarkRunStatusShared(status);
      setRunStatus(status);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRunError(message);
    } finally {
      setIsRunLoading(false);
    }
  }, [runStatus?.runId, setIsRunLoading, setRunError, setRunStatus]);

  useEffect(() => {
    if (
      !runStatus?.runId ||
      runStatus.status !== BENCHMARK_RUN_STATUS.RUNNING
    ) {
      return;
    }

    let cancelled = false;
    const runId = runStatus.runId;
    const poll = startVisibilityAwarePoll({
      intervalMs: RUN_STATUS_POLL_INTERVAL_MS,
      task: async () => {
        const status = await getBenchmarkRunStatusShared(runId);
        if (!cancelled) {
          setRunStatus(status);
        }
      },
      onError: (error) => {
        if (!cancelled) {
          setRunError(error instanceof Error ? error.message : String(error));
        }
      },
    });

    return () => {
      cancelled = true;
      poll.stop();
    };
  }, [runStatus?.runId, runStatus?.status, setRunError, setRunStatus]);

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
