import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo } from "react";

import {
  BENCHMARK_AGENT_BATCH_STATUS,
  type BenchmarkAgentLaunchSelection,
  benchmarkApi,
} from "@src/api/tauri/benchmark";
import { DISPATCH_CATEGORY } from "@src/api/tauri/session";
import { useAdvancedConfig } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useAdvancedConfig";
import { resolveKeys } from "@src/engines/SessionCore/hooks/session/useSessionCreator/useSessionLaunch/resolveKeys";
import { useVisiblePolling } from "@src/hooks/async";
import {
  benchmarkActiveBatchIdAtom,
  benchmarkActiveBatchTaskIdAtom,
  benchmarkAgentBatchErrorAtom,
  benchmarkAgentBatchLoadingAtom,
  benchmarkAgentBatchStatusAtom,
  benchmarkBatchConcurrencyAtom,
  benchmarkBatchSelectedTaskIdsAtom,
  benchmarkKindAtom,
  benchmarkRunTypeAtom,
  benchmarkSelectedTaskIdAtom,
  benchmarkSourcePathAtom,
  benchmarkWorkingDirectoryAtom,
} from "@src/store/benchmark";
import {
  SESSION_TARGET_KIND,
  activeSessionIdAtom,
  creatorDefaultExecModeAtom,
  loadSidebarSessions,
  sessionCreatorStateAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import {
  CHAT_PANEL_CONTENT_MODE,
  activeStationChatVisibleAtom,
  chatPanelContentModeAtom,
  chatPanelMaximizedAtom,
} from "@src/store/ui/chatPanelAtom";

const AGENT_BATCH_STATUS_POLL_INTERVAL_MS = 2_000;

export function useBenchmarkAgentBatchRun() {
  const kind = useAtomValue(benchmarkKindAtom);
  const sourcePath = useAtomValue(benchmarkSourcePathAtom);
  const workingDirectory = useAtomValue(benchmarkWorkingDirectoryAtom);
  const selectedTaskId = useAtomValue(benchmarkSelectedTaskIdAtom);
  const runType = useAtomValue(benchmarkRunTypeAtom);
  const selectedBatchTaskIds = useAtomValue(benchmarkBatchSelectedTaskIdsAtom);
  const concurrency = useAtomValue(benchmarkBatchConcurrencyAtom);
  const creatorState = useAtomValue(sessionCreatorStateAtom);
  const agentExecMode = useAtomValue(creatorDefaultExecModeAtom);
  const { advancedConfig } = useAdvancedConfig();
  const [batchStatus, setBatchStatus] = useAtom(benchmarkAgentBatchStatusAtom);
  const [isBatchLoading, setIsBatchLoading] = useAtom(
    benchmarkAgentBatchLoadingAtom
  );
  const setActiveBatchId = useSetAtom(benchmarkActiveBatchIdAtom);
  const setActiveBatchTaskId = useSetAtom(benchmarkActiveBatchTaskIdAtom);
  const setBatchError = useSetAtom(benchmarkAgentBatchErrorAtom);
  const setChatPanelContentMode = useSetAtom(chatPanelContentModeAtom);
  const setActiveStationChatVisible = useSetAtom(activeStationChatVisibleAtom);
  const setChatPanelMaximized = useSetAtom(chatPanelMaximizedAtom);
  const setActiveSessionId = useSetAtom(activeSessionIdAtom);
  const setWorkstationActiveSessionId = useSetAtom(
    workstationActiveSessionIdAtom
  );

  const taskIdsForLaunch = useMemo(() => {
    if (runType === "single") {
      return selectedTaskId ? [selectedTaskId] : [];
    }
    return selectedBatchTaskIds;
  }, [runType, selectedBatchTaskIds, selectedTaskId]);

  const buildLaunchSelection = useCallback(async () => {
    const keySource = advancedConfig.keySource ?? "own_key";
    const resolvedKeys = await resolveKeys(keySource, advancedConfig, {
      onAuthError: () => {
        setBatchError("Please sign in before launching hosted-key benchmarks.");
      },
    });
    if (!resolvedKeys) {
      return null;
    }

    const isRustAgent =
      creatorState.dispatchCategory === DISPATCH_CATEGORY.RUST_AGENT;
    const launch: BenchmarkAgentLaunchSelection = {
      category: creatorState.dispatchCategory,
      workspacePath:
        workingDirectory.trim() || creatorState.source?.repoPath || undefined,
      keySource: resolvedKeys.keySource,
      accountId: resolvedKeys.accountId,
      model: resolvedKeys.model,
      nativeHarnessType: isRustAgent
        ? resolvedKeys.nativeHarnessType
        : undefined,
      platform: resolvedKeys.cliAgentType,
      branch: resolvedKeys.branch ?? creatorState.source?.branch,
      hostedToken: resolvedKeys.hostedToken,
      tier: resolvedKeys.tier,
      agentDefinitionId:
        isRustAgent && creatorState.targetKind === SESSION_TARGET_KIND.AGENT
          ? (creatorState.selectedAgentDefinitionId ?? undefined)
          : undefined,
      agentOrgId:
        isRustAgent && creatorState.targetKind === SESSION_TARGET_KIND.AGENT_ORG
          ? (creatorState.selectedAgentOrgId ?? undefined)
          : undefined,
      agentOrgMemberOverrides: creatorState.selectedAgentOrgId
        ? advancedConfig.agentOrgMemberOverrides
        : undefined,
      applyAgentOrgMemberOverridesForFuture:
        creatorState.selectedAgentOrgId &&
        advancedConfig.applyAgentOrgMemberOverridesForFuture !== false
          ? true
          : undefined,
      mode: agentExecMode,
    };
    return launch;
  }, [
    advancedConfig,
    agentExecMode,
    creatorState,
    setBatchError,
    workingDirectory,
  ]);

  const refreshBatchStatus = useCallback(async () => {
    if (!batchStatus?.batchId) {
      return null;
    }
    const nextStatus = await benchmarkApi.getAgentBatchStatus({
      batchId: batchStatus.batchId,
    });
    setBatchStatus(nextStatus);
    return nextStatus;
  }, [batchStatus?.batchId, setBatchStatus]);

  const startBatch = useCallback(async () => {
    const trimmedSourcePath = sourcePath.trim();
    if (!trimmedSourcePath) {
      setBatchError("Select a benchmark source folder before launching.");
      return null;
    }
    if (taskIdsForLaunch.length === 0) {
      setBatchError("Select at least one benchmark task before launching.");
      return null;
    }
    if (!workingDirectory.trim()) {
      setBatchError(
        "Set a working directory before launching benchmark agents."
      );
      return null;
    }

    setIsBatchLoading(true);
    setBatchError(null);
    try {
      const launch = await buildLaunchSelection();
      if (!launch) {
        return null;
      }
      const status = await benchmarkApi.startAgentBatch({
        kind,
        sourcePath: trimmedSourcePath,
        taskIds: taskIdsForLaunch,
        launch,
        concurrency,
      });
      setBatchStatus(status);
      setActiveBatchId(status.batchId);
      setActiveBatchTaskId(null);
      setActiveSessionId(status.masterSessionId);
      setWorkstationActiveSessionId(status.masterSessionId);
      setChatPanelContentMode(CHAT_PANEL_CONTENT_MODE.BENCHMARK_SESSION_GROUP);
      setActiveStationChatVisible("my-station", true);
      setChatPanelMaximized(false);
      void loadSidebarSessions({ forceRefresh: true });
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBatchError(message);
      return null;
    } finally {
      setIsBatchLoading(false);
    }
  }, [
    buildLaunchSelection,
    concurrency,
    kind,
    setActiveBatchId,
    setActiveBatchTaskId,
    setActiveSessionId,
    setActiveStationChatVisible,
    setBatchError,
    setBatchStatus,
    setChatPanelContentMode,
    setChatPanelMaximized,
    setIsBatchLoading,
    setWorkstationActiveSessionId,
    sourcePath,
    taskIdsForLaunch,
    workingDirectory,
  ]);

  const cancelBatch = useCallback(async () => {
    if (!batchStatus?.batchId) {
      return null;
    }
    setIsBatchLoading(true);
    setBatchError(null);
    try {
      const status = await benchmarkApi.cancelAgentBatch({
        batchId: batchStatus.batchId,
      });
      setBatchStatus(status);
      return status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBatchError(message);
      return null;
    } finally {
      setIsBatchLoading(false);
    }
  }, [batchStatus?.batchId, setBatchError, setBatchStatus, setIsBatchLoading]);

  useEffect(() => {
    if (batchStatus?.batchId) {
      return undefined;
    }
    let cancelled = false;
    benchmarkApi
      .listAgentBatchHistories({ limit: 1 })
      .then((histories) => {
        if (cancelled || histories.length === 0) return;
        const [latestHistory] = histories;
        setBatchStatus(latestHistory);
        setActiveBatchId(latestHistory.batchId);
      })
      .catch((error) => {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : String(error);
          setBatchError(message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [batchStatus?.batchId, setActiveBatchId, setBatchError, setBatchStatus]);

  const pollBatchStatus = useCallback(
    async (signal: AbortSignal) => {
      if (!batchStatus?.batchId) return false;
      try {
        const status = await benchmarkApi.getAgentBatchStatus({
          batchId: batchStatus.batchId,
        });
        if (signal.aborted) return false;
        setBatchStatus(status);
        setBatchError(null);
        return status.status === BENCHMARK_AGENT_BATCH_STATUS.RUNNING;
      } catch (error) {
        if (signal.aborted) return false;
        const message = error instanceof Error ? error.message : String(error);
        setBatchError(message);
        return true;
      }
    },
    [batchStatus?.batchId, setBatchError, setBatchStatus]
  );

  useVisiblePolling({
    enabled:
      !!batchStatus?.batchId &&
      batchStatus.status === BENCHMARK_AGENT_BATCH_STATUS.RUNNING,
    intervalMs: AGENT_BATCH_STATUS_POLL_INTERVAL_MS,
    poll: pollBatchStatus,
    immediate: false,
  });

  return {
    batchStatus,
    cancelBatch,
    isBatchLoading,
    refreshBatchStatus,
    startBatch,
    taskIdsForLaunch,
  };
}
