import { useEffect, useRef } from "react";

import Message from "@src/components/Message";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { createLogger } from "@src/hooks/logger";
import type { WorkItem as WorkItemExtended } from "@src/types/core/workItem";

import { buildReviewTaskPrompt } from "../../components/WorkItemDetail/promptBuilder";
import {
  AGENT_ROLE,
  ORCHESTRATOR_PHASE,
  PENDING_SESSION_ID,
  SESSION_STATUS,
  formatOrchestratorError,
} from "../../constants";
import type { AgentRole } from "../../constants";

const logger = createLogger("useAutoReview");

interface UseAutoReviewOptions {
  workItem: WorkItemExtended;
  projectRepoPath: string | null;
  accountId: string | null;
  modelId?: string;
  shortId: string | null;
  projectSlug: string | null;
  resolveSessionRepoPath: () => string;
  onRefreshWorkItem?: () => void;
  isStartingAgent: boolean;
  setIsStartingAgent: (value: boolean) => void;
  setActiveAgentSessionId: (value: string | null) => void;
  setActiveAgentRole: (value: AgentRole | null) => void;
}

/**
 * Auto-launch review session when orchestrator transitions to "review" phase.
 *
 * IMPORTANT: `isStartingAgent` is tracked via ref so it does NOT appear in the
 * effect dependency array — including it would cause the effect to re-fire
 * during the SDE→review transition while the SDE session is still tearing down.
 */
export function useAutoReview(options: UseAutoReviewOptions): void {
  const {
    workItem,
    projectRepoPath,
    accountId,
    modelId,
    shortId,
    projectSlug,
    resolveSessionRepoPath,
    onRefreshWorkItem,
    isStartingAgent,
    setIsStartingAgent,
    setActiveAgentSessionId,
    setActiveAgentRole,
  } = options;

  const reviewLaunchRef = useRef(false);
  const isStartingAgentRef = useRef(isStartingAgent);
  useEffect(() => {
    isStartingAgentRef.current = isStartingAgent;
  }, [isStartingAgent]);

  useEffect(() => {
    const phase = workItem.orchestratorState?.current_phase;
    if (phase !== ORCHESTRATOR_PHASE.Review) {
      reviewLaunchRef.current = false;
      return;
    }
    if (reviewLaunchRef.current || isStartingAgentRef.current) return;

    const hasActiveReview = workItem.linkedSessions?.some(
      (ls) =>
        ls.agent_role === AGENT_ROLE.Review &&
        ls.status === SESSION_STATUS.Running &&
        ls.session_id !== PENDING_SESSION_ID
    );
    if (hasActiveReview) return;

    // Only lock the ref AFTER validating params — if params are temporarily
    // null (still loading), we leave the ref unlocked so the effect can
    // retry on the next render when params become available.
    if (!projectRepoPath || !accountId || !shortId) return;

    reviewLaunchRef.current = true;

    let cancelled = false;
    const launchReview = async () => {
      setIsStartingAgent(true);
      try {
        const reviewPrompt = buildReviewTaskPrompt(
          workItem,
          shortId,
          workItem.proofOfWork?.branch ?? undefined,
          undefined
        );

        const { sessionId: createdSessionId } = await SessionService.create({
          task: reviewPrompt,
          repoPath: projectRepoPath,
          projectRepoPath,
          worktreePath:
            resolveSessionRepoPath() !== projectRepoPath
              ? resolveSessionRepoPath()
              : undefined,
          accountId,
          model: modelId,
          workItemId: shortId,
          agentRole: AGENT_ROLE.Review,
          mode: AGENT_ROLE.Review,
          projectSlug: projectSlug ?? undefined,
        });

        if (!cancelled) {
          setActiveAgentSessionId(createdSessionId);
          setActiveAgentRole(AGENT_ROLE.Review);
          logger.info(
            `Started Review agent for ${shortId}, sessionId=${createdSessionId}`
          );
          onRefreshWorkItem?.();
        }
      } catch (error) {
        const msg = formatOrchestratorError(error);
        logger.error(`Failed to start review agent: ${msg}`);
        if (!cancelled) {
          Message.error(msg);
          onRefreshWorkItem?.();
        }
      } finally {
        if (!cancelled) setIsStartingAgent(false);
      }
    };
    launchReview();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    workItem.orchestratorState?.current_phase,
    workItem.linkedSessions,
    workItem.name,
    workItem.spec,
    workItem.todos,
    workItem.proofOfWork?.branch,
    workItem.proofOfWork?.review_feedback,
    workItem.proofOfWork?.review_history,
    accountId,
    modelId,
    projectRepoPath,
    shortId,
    resolveSessionRepoPath,
    onRefreshWorkItem,
  ]);
}
