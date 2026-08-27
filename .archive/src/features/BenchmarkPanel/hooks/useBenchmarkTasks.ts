import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect } from "react";

import { benchmarkApi } from "@src/api/tauri/benchmark";
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

  const loadTasks = useCallback(async () => {
    const trimmedSourcePath = sourcePath.trim();
    if (!trimmedSourcePath) {
      setError(null);
      setTasks([]);
      setSelectedTaskId(null);
      setSelectedTaskAtom(null);
      return;
    }

    setIsLoadingTasks(true);
    setError(null);
    try {
      const rows = await benchmarkApi.listTasks({
        kind,
        sourcePath: trimmedSourcePath,
        limit: BENCHMARK_TASK_LIST_LIMIT,
      });
      setTasks(rows);
      setSelectedTaskId((currentTaskId) => {
        if (rows.some((row) => row.taskId === currentTaskId)) {
          return currentTaskId;
        }
        return rows[0]?.taskId ?? null;
      });
    } catch (loadError) {
      setError(
        loadError instanceof Error ? loadError.message : String(loadError)
      );
      setTasks([]);
      setSelectedTaskId(null);
      setSelectedTaskAtom(null);
    } finally {
      setIsLoadingTasks(false);
    }
  }, [
    kind,
    setError,
    setIsLoadingTasks,
    setSelectedTaskAtom,
    setSelectedTaskId,
    setTasks,
    sourcePath,
  ]);

  useEffect(() => {
    if (!loadOnMount) return;

    const trimmedSourcePath = sourcePath.trim();
    if (!trimmedSourcePath) {
      setError(null);
      setTasks([]);
      setSelectedTaskId(null);
      setSelectedTaskAtom(null);
      return;
    }

    let cancelled = false;
    async function loadInitialTasks() {
      setIsLoadingTasks(true);
      setError(null);
      try {
        const rows = await benchmarkApi.listTasks({
          kind,
          sourcePath: trimmedSourcePath,
          limit: BENCHMARK_TASK_LIST_LIMIT,
        });
        if (cancelled) return;
        setTasks(rows);
        setSelectedTaskId((currentTaskId) => {
          if (rows.some((row) => row.taskId === currentTaskId)) {
            return currentTaskId;
          }
          return rows[0]?.taskId ?? null;
        });
      } catch (loadError) {
        if (cancelled) return;
        setError(
          loadError instanceof Error ? loadError.message : String(loadError)
        );
        setTasks([]);
        setSelectedTaskId(null);
        setSelectedTaskAtom(null);
      } finally {
        if (!cancelled) {
          setIsLoadingTasks(false);
        }
      }
    }

    loadInitialTasks();
    return () => {
      cancelled = true;
    };
  }, [
    kind,
    loadOnMount,
    setError,
    setIsLoadingTasks,
    setSelectedTaskAtom,
    setSelectedTaskId,
    setTasks,
    sourcePath,
  ]);

  useEffect(() => {
    if (!loadDetail) return;

    if (!selectedTaskId) {
      setSelectedTask(null);
      return;
    }

    let cancelled = false;
    const taskId = selectedTaskId;

    async function loadTaskDetail() {
      setIsLoadingDetail(true);
      setError(null);
      try {
        const detail = await benchmarkApi.getTask({
          kind,
          sourcePath,
          taskId,
        });
        if (!cancelled) {
          setSelectedTask(detail);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(
            loadError instanceof Error ? loadError.message : String(loadError)
          );
          setSelectedTask(null);
        }
      } finally {
        if (!cancelled) {
          setIsLoadingDetail(false);
        }
      }
    }

    loadTaskDetail();
    return () => {
      cancelled = true;
    };
  }, [
    kind,
    loadDetail,
    selectedTaskId,
    setError,
    setIsLoadingDetail,
    setSelectedTask,
    sourcePath,
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
