import {
  BENCHMARK_AGENT_BATCH_STATUS,
  BENCHMARK_EVALUATION_MODE,
  BENCHMARK_KIND,
  benchmarkApi,
} from "@src/api/tauri/benchmark";
import { router } from "@src/router";
import {
  benchmarkActiveBatchIdAtom,
  benchmarkActiveBatchTaskIdAtom,
  benchmarkAgentBatchStatusAtom,
  benchmarkKindAtom,
  benchmarkRunStatusAtom,
  benchmarkSelectedTaskIdAtom,
  benchmarkSourcePathAtom,
} from "@src/store/benchmark";
import {
  CHAT_PANEL_CONTENT_MODE,
  activeStationChatVisibleAtom,
  chatPanelContentModeAtom,
  chatPanelMaximizedAtom,
} from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";

import { asError } from "../result";
import type { E2EStore, Json, Result } from "../types";

interface SeedBenchmarkRunOptions {
  batchId?: string;
  sourcePath: string;
  taskIds: string[];
  activeTaskId?: string;
}

interface StartLocalDockerBenchmarkRunOptions {
  sourcePath: string;
  taskId: string;
  patch: string;
}

export function createBenchmarkE2EHelpers(store: E2EStore) {
  const seedBenchmarkRun = async (
    options: SeedBenchmarkRunOptions
  ): Promise<Result<{ batchId: string; activeTaskId: string | null }>> => {
    try {
      const batchId = options.batchId ?? `e2e-benchmark-${Date.now()}`;
      const activeTaskId = options.activeTaskId ?? options.taskIds[0] ?? null;
      const now = new Date().toISOString();
      const status = {
        batchId,
        benchmarkKind: BENCHMARK_KIND.SWE_BENCH_PRO,
        sourcePath: options.sourcePath,
        masterSessionId: `e2e-benchmark-master-${batchId}`,
        masterSessionName: "SWE-bench Pro - E2E",
        status: BENCHMARK_AGENT_BATCH_STATUS.RUNNING,
        totalTasks: options.taskIds.length,
        queued: Math.max(options.taskIds.length - 1, 0),
        running: options.taskIds.length > 0 ? 1 : 0,
        launched: 0,
        failed: 0,
        cancelled: 0,
        createdAt: now,
        startedAt: now,
        finishedAt: null,
        concurrency: 2,
        items: options.taskIds.map((taskId, index) => ({
          taskId,
          status:
            index === 0
              ? BENCHMARK_AGENT_BATCH_STATUS.RUNNING
              : BENCHMARK_AGENT_BATCH_STATUS.QUEUED,
          sessionId: index === 0 ? `e2e-session-${taskId}` : null,
          sessionName: null,
          startedAt: index === 0 ? now : null,
          finishedAt: null,
          error: null,
          logs: [],
        })),
        error: null,
      };

      store.set(benchmarkKindAtom, BENCHMARK_KIND.SWE_BENCH_PRO);
      store.set(benchmarkSourcePathAtom, options.sourcePath);
      store.set(benchmarkAgentBatchStatusAtom, status);
      store.set(benchmarkActiveBatchIdAtom, batchId);
      store.set(benchmarkActiveBatchTaskIdAtom, activeTaskId);
      store.set(benchmarkSelectedTaskIdAtom, activeTaskId);

      store.set(stationModeAtom, "my-station");
      store.set(
        chatPanelContentModeAtom,
        CHAT_PANEL_CONTENT_MODE.BENCHMARK_SESSION_GROUP
      );
      store.set(chatPanelMaximizedAtom, false);
      store.set(activeStationChatVisibleAtom, "my-station", true);
      await router.navigate("/orgii/workstation/code");

      return { ok: true, batchId, activeTaskId };
    } catch (error) {
      return asError(error);
    }
  };

  const inspectBenchmarkRun = async (): Promise<
    Result<{
      batchStatus: Json | null;
      activeBatchId: string | null;
      activeTaskId: string | null;
    }>
  > => {
    try {
      return {
        ok: true,
        batchStatus: store.get(
          benchmarkAgentBatchStatusAtom
        ) as unknown as Json | null,
        activeBatchId: store.get(benchmarkActiveBatchIdAtom),
        activeTaskId: store.get(benchmarkActiveBatchTaskIdAtom),
      };
    } catch (error) {
      return asError(error);
    }
  };

  const startLocalDockerBenchmarkRun = async (
    options: StartLocalDockerBenchmarkRunOptions
  ): Promise<Result<{ status: Json }>> => {
    try {
      store.set(benchmarkKindAtom, BENCHMARK_KIND.SWE_BENCH_PRO);
      store.set(benchmarkSourcePathAtom, options.sourcePath);
      store.set(benchmarkSelectedTaskIdAtom, options.taskId);
      const status = await benchmarkApi.startRun({
        kind: BENCHMARK_KIND.SWE_BENCH_PRO,
        sourcePath: options.sourcePath,
        taskId: options.taskId,
        patch: options.patch,
        evaluationMode: BENCHMARK_EVALUATION_MODE.LOCAL_DOCKER,
      });
      store.set(benchmarkRunStatusAtom, status);
      return { ok: true, status: status as unknown as Json };
    } catch (error) {
      return asError(error);
    }
  };

  const getBenchmarkRunStatus = async (
    runId: string
  ): Promise<Result<{ status: Json }>> => {
    try {
      const status = await benchmarkApi.getRunStatus({ runId });
      store.set(benchmarkRunStatusAtom, status);
      return { ok: true, status: status as unknown as Json };
    } catch (error) {
      return asError(error);
    }
  };

  return {
    seedBenchmarkRun,
    inspectBenchmarkRun,
    startLocalDockerBenchmarkRun,
    getBenchmarkRunStatus,
  };
}
