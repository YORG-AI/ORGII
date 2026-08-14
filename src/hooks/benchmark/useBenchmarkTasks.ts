import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo } from "react";

import {
  BENCHMARK_TASK_LIST_LIMIT,
  benchmarkErrorAtom,
  benchmarkKindAtom,
  benchmarkSelectedTaskAtom,
  benchmarkSelectedTaskIdAtom,
  benchmarkSourcePathAtom,
  benchmarkTaskDetailLoadingAtom,
  benchmarkTasksAtom,
  benchmarkTasksLoadingAtom,
} from "@src/store/benchmark";
import { LatestScopedTask } from "@src/util/core/latestScopedTask";

import {
  getBenchmarkTaskShared,
  listBenchmarkTasksShared,
} from "./benchmarkRequestCoordinator";

interface UseBenchmarkTasksOptions {
  loadDetail?: boolean;
  loadOnMount?: boolean;
}

export function useBenchmarkTasks({
  loadDetail = true,
  loadOnMount = true,
}: UseBenchmarkTasksOptions = {}) {
  const [kind, setKind] = useAtom(benchmarkKindAtom);
  const [sourcePath, setSourcePath] = useAtom(benchmarkSourcePathAtom);
  const [tasks, setTasks] = useAtom(benchmarkTasksAtom);
  const [selectedTaskId, setSelectedTaskId] = useAtom(
    benchmarkSelectedTaskIdAtom
  );
  const [selectedTask, setSelectedTask] = useAtom(benchmarkSelectedTaskAtom);
  const [isLoadingTasks, setIsLoadingTasks] = useAtom(
    benchmarkTasksLoadingAtom
  );
  const [isLoadingDetail, setIsLoadingDetail] = useAtom(
    benchmarkTaskDetailLoadingAtom
  );
  const [error, setError] = useAtom(benchmarkErrorAtom);
  const setSelectedTaskAtom = useSetAtom(benchmarkSelectedTaskAtom);
  const taskListCoordinator = useMemo(() => new LatestScopedTask(), []);
  const taskDetailCoordinator = useMemo(() => new LatestScopedTask(), []);

  const loadTasks = useCallback(async () => {
    const trimmedSourcePath = sourcePath.trim();
    if (!trimmedSourcePath) {
      taskListCoordinator.supersede();
      setError(null);
      setTasks([]);
      setSelectedTaskId(null);
      setSelectedTaskAtom(null);
      setIsLoadingTasks(false);
      return;
    }

    const scopeKey = JSON.stringify([kind, trimmedSourcePath]);
    await taskListCoordinator.run(scopeKey, async (context) => {
      setIsLoadingTasks(true);
      setError(null);
      try {
        const rows = await listBenchmarkTasksShared({
          kind,
          sourcePath: trimmedSourcePath,
          limit: BENCHMARK_TASK_LIST_LIMIT,
        });
        if (!context.isCurrent()) return;
        setTasks(rows);
        setSelectedTaskId((currentTaskId) => {
          if (rows.some((row) => row.taskId === currentTaskId)) {
            return currentTaskId;
          }
          return rows[0]?.taskId ?? null;
        });
      } catch (loadError) {
        if (!context.isCurrent()) return;
        setError(
          loadError instanceof Error ? loadError.message : String(loadError)
        );
        setTasks([]);
        setSelectedTaskId(null);
        setSelectedTaskAtom(null);
      } finally {
        if (context.isCurrent()) {
          setIsLoadingTasks(false);
        }
      }
    });
  }, [
    kind,
    setError,
    setIsLoadingTasks,
    setSelectedTaskAtom,
    setSelectedTaskId,
    setTasks,
    sourcePath,
    taskListCoordinator,
  ]);

  useEffect(() => {
    if (!loadOnMount) return;
    void loadTasks();
    return () => {
      taskListCoordinator.supersede();
    };
  }, [loadOnMount, loadTasks, taskListCoordinator]);

  useEffect(() => {
    if (!loadDetail) return;

    if (!selectedTaskId) {
      taskDetailCoordinator.supersede();
      setSelectedTask(null);
      setIsLoadingDetail(false);
      return;
    }

    const taskId = selectedTaskId;
    const scopeKey = JSON.stringify([kind, sourcePath, taskId]);
    void taskDetailCoordinator.run(scopeKey, async (context) => {
      setIsLoadingDetail(true);
      setError(null);
      try {
        const detail = await getBenchmarkTaskShared({
          kind,
          sourcePath,
          taskId,
        });
        if (context.isCurrent()) {
          setSelectedTask(detail);
        }
      } catch (loadError) {
        if (context.isCurrent()) {
          setError(
            loadError instanceof Error ? loadError.message : String(loadError)
          );
          setSelectedTask(null);
        }
      } finally {
        if (context.isCurrent()) {
          setIsLoadingDetail(false);
        }
      }
    });
    return () => {
      taskDetailCoordinator.supersede();
    };
  }, [
    kind,
    loadDetail,
    selectedTaskId,
    setError,
    setIsLoadingDetail,
    setSelectedTask,
    sourcePath,
    taskDetailCoordinator,
  ]);

  return {
    error,
    isLoadingDetail,
    isLoadingTasks,
    loadTasks,
    kind,
    selectedTask,
    selectedTaskId,
    setKind,
    setSelectedTaskId,
    setSourcePath,
    sourcePath,
    tasks,
  };
}
