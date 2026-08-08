import { useCallback, useEffect, useRef } from "react";

import { getSession } from "@src/api/tauri/agent";
import { createLogger } from "@src/hooks/logger";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";
import { invokeTauri } from "@src/util/platform/tauri/init";

import {
  ACTIVE_PHASES,
  ORCHESTRATOR_COMMAND,
  PENDING_SESSION_ID,
  SESSION_STATUS,
} from "../../constants";

const logger = createLogger("useStaleSessionDetection");

const STALE_GRACE_PERIOD_MS = 5000;

interface UseStaleSessionDetectionOptions {
  enabled: boolean;
  workItem: WorkItemExtended;
  projectRepoPath: string | null;
  projectSlug: string | null;
  shortId: string | null;
  isStartingAgent: boolean;
  handleCancelAgent: () => Promise<void>;
  onRefreshWorkItem?: () => void;
}

/**
 * Two effects that detect stale orchestrator state:
 *
 * 1. On mount / session change: compare frontend phase with backend phase
 *    and refresh if they diverge.
 *
 * 2. When phase is sde/review: verify that linked sessions are still alive.
 *    If they are terminal or missing, wait a grace period then cancel.
 */
export function useStaleSessionDetection(
  options: UseStaleSessionDetectionOptions
): void {
  const {
    enabled,
    workItem,
    projectRepoPath,
    projectSlug,
    shortId,
    isStartingAgent,
    handleCancelAgent,
    onRefreshWorkItem,
  } = options;

  const syncCheckDoneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      syncCheckDoneRef.current = null;
      return;
    }
    if (!projectRepoPath || !projectSlug || !shortId) return;
    if (syncCheckDoneRef.current === workItem.session_id) return;
    syncCheckDoneRef.current = workItem.session_id;

    let cancelled = false;
    const syncState = async () => {
      try {
        const status = await invokeTauri<{
          currentPhase: string;
          retryCount: number;
          interrupted: boolean;
          hasActiveConfig: boolean;
        }>(ORCHESTRATOR_COMMAND.GetStatus, {
          projectSlug,
          workItemId: shortId,
        });

        const frontendPhase =
          workItem.orchestratorState?.current_phase ?? "idle";
        const backendPhase = status.currentPhase;

        if (frontendPhase !== backendPhase && !cancelled) {
          logger.info(
            `Orchestrator state mismatch: frontend=${frontendPhase}, backend=${backendPhase}. Refreshing.`
          );
          onRefreshWorkItem?.();
        }
      } catch {
        // orchestrator_get_status may fail before the project store is initialized
      }
    };
    syncState();
    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    workItem.session_id,
    workItem.orchestratorState?.current_phase,
    projectRepoPath,
    projectSlug,
    shortId,
    onRefreshWorkItem,
  ]);

  const graceCheckAndCancel = useCallback(
    async (
      phase: string,
      cancelledRef: { current: boolean },
      reason: string
    ): Promise<void> => {
      if (!projectRepoPath || !projectSlug || !shortId) {
        await handleCancelAgent();
        return;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, STALE_GRACE_PERIOD_MS)
      );
      if (cancelledRef.current) return;
      try {
        const freshStatus = await invokeTauri<{ currentPhase: string }>(
          ORCHESTRATOR_COMMAND.GetStatus,
          { projectSlug, workItemId: shortId }
        );
        if (cancelledRef.current) return;
        if (freshStatus.currentPhase !== phase) {
          onRefreshWorkItem?.();
          return;
        }
      } catch {
        // Network or init error — still cancel after grace period
        if (cancelledRef.current) return;
      }
      if (!cancelledRef.current) {
        logger.info(`${reason}, cancelling orchestrator after grace period`);
        await handleCancelAgent();
      }
    },
    [
      projectRepoPath,
      projectSlug,
      shortId,
      handleCancelAgent,
      onRefreshWorkItem,
    ]
  );

  // Key the stale check on phase + the serialized linked session IDs so that
  // when sessions change (e.g. after a retry spawns a new session), we run
  // a fresh stale check instead of being permanently locked out.
  const linkedSessionKey = workItem.linkedSessions
    ?.map((ls) => `${ls.session_id}:${ls.status}`)
    .join(",");

  const staleCheckDoneRef = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) {
      staleCheckDoneRef.current = null;
      return;
    }
    if (isStartingAgent) return;

    const phase = workItem.orchestratorState?.current_phase;
    if (!phase || !ACTIVE_PHASES.has(phase)) {
      staleCheckDoneRef.current = null;
      return;
    }

    const checkKey = `${phase}::${linkedSessionKey}`;
    if (staleCheckDoneRef.current === checkKey) return;
    staleCheckDoneRef.current = checkKey;

    const runningLinked = workItem.linkedSessions?.filter(
      (ls) =>
        ls.status === SESSION_STATUS.Running &&
        ls.session_id !== PENDING_SESSION_ID &&
        ls.session_id.length > 0
    );
    if (!runningLinked || runningLinked.length === 0) {
      const hasPendingPlaceholders = workItem.linkedSessions?.some(
        (ls) => ls.session_id === PENDING_SESSION_ID
      );
      if (hasPendingPlaceholders) {
        staleCheckDoneRef.current = null;
        return;
      }

      const cancelledRef = { current: false };
      graceCheckAndCancel(phase, cancelledRef, "No running sessions");
      return () => {
        cancelledRef.current = true;
      };
    }

    const cancelledRef = { current: false };
    const checkSessions = async () => {
      for (const ls of runningLinked) {
        if (cancelledRef.current) return;
        try {
          const session = (await getSession(ls.session_id)) as unknown as {
            session_id: string;
            status: string;
          } | null;
          const status = session?.status;
          if (
            !session ||
            status === SESSION_STATUS.Completed ||
            status === SESSION_STATUS.Failed ||
            status === SESSION_STATUS.Cancelled
          ) {
            await graceCheckAndCancel(
              phase,
              cancelledRef,
              `Stale session ${ls.session_id} (status=${status ?? "missing"})`
            );
            return;
          }
        } catch {
          if (!cancelledRef.current) {
            logger.info(
              `Session ${ls.session_id} not found, cancelling orchestrator`
            );
            await handleCancelAgent();
          }
          return;
        }
      }
    };
    checkSessions();
    return () => {
      cancelledRef.current = true;
    };
  }, [
    enabled,
    workItem.orchestratorState?.current_phase,
    workItem.linkedSessions,
    linkedSessionKey,
    handleCancelAgent,
    isStartingAgent,
    graceCheckAndCancel,
  ]);
}
