import { RefreshCw } from "lucide-react";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  LinkedSession,
  OrchestratorConfig,
  OrchestratorPhase,
  OrchestratorState,
  ProofOfWork,
  WorkItemExecutionLock,
} from "@src/api/http/project";
import Button from "@src/components/Button";
import { useRefreshSpin } from "@src/hooks/ui";
import { WorkstationToolbarTooltip } from "@src/modules/WorkStation/shared";
import { SECTION_CONTAINER_CLASSES } from "@src/modules/shared/layouts/SectionLayout/tokens";
import { CollapsibleSection } from "@src/modules/shared/layouts/blocks";
import type { WorkItemStatus } from "@src/types/core/workItem";

import {
  ACTIVE_PHASES,
  AGENT_ROLE,
  type AgentRole,
  ORCHESTRATOR_PHASE,
  toAgentRole,
} from "../../constants";
import {
  ActivePhaseStatus,
  AwaitingUserState,
  CompletedState,
  FailedState,
  IdleState,
  InterruptedState,
} from "./PhaseStates";
import PipelineStepper from "./PipelineStepper";
import ReviewFeedbackPanel from "./ReviewFeedbackPanel";
import SessionRunHistory from "./SessionRunHistory";
import { useSessionRunsGrouping } from "./hooks/useSessionRunsGrouping";

const ACTIVE_WORK_ITEM_STATUS: WorkItemStatus = "in_progress";
const COMPLETED_WORK_ITEM_STATUS: WorkItemStatus = "completed";
const RUNNING_LINKED_SESSION_STATUS = "running" as const;

interface AgentWorkflowProps {
  orchestratorState?: OrchestratorState;
  orchestratorConfig?: OrchestratorConfig;
  proofOfWork?: ProofOfWork;
  workItemStatus?: WorkItemStatus;
  executionLock?: WorkItemExecutionLock | null;
  linkedSessions?: LinkedSession[];
  onStartAgent?: (instructions?: string) => void;
  isStartingAgent?: boolean;
  onRetry?: () => void;
  onCancel?: () => void;
  onResume?: () => void;
  onAcceptAsIs?: () => void;
  onCreateFollowUp?: () => void;
  onOpenSession?: (sessionId: string, title?: string) => void;
  onOpenFileAtLine?: (filePath: string, line?: number) => void;
  onRefresh?: () => void;
  activeAgentSessionId?: string | null;
  activeAgentRole?: AgentRole | null;
  /** Collab execution lock held by a teammate (design §16.6). */
  isLockedByOther?: boolean;
  lockHolderName?: string | null;
}

const AgentWorkflow: React.FC<AgentWorkflowProps> = ({
  orchestratorState,
  orchestratorConfig,
  proofOfWork,
  workItemStatus,
  executionLock,
  linkedSessions = [],
  onStartAgent,
  isStartingAgent,
  onRetry,
  onCancel,
  onResume,
  onAcceptAsIs,
  onCreateFollowUp,
  onOpenSession,
  onOpenFileAtLine,
  onRefresh,
  activeAgentSessionId,
  activeAgentRole,
  isLockedByOther,
  lockHolderName,
}) => {
  const { t } = useTranslation("projects");
  const persistedPhase: OrchestratorPhase =
    orchestratorState?.current_phase ?? ORCHESTRATOR_PHASE.Idle;
  const { cycleCount, sessionRuns, subAgentsByParent, hasRuns } =
    useSessionRunsGrouping({ linkedSessions, activeAgentSessionId });
  const [terminalSessionIds, setTerminalSessionIds] = useState<Set<string>>(
    () => new Set()
  );
  const handleSessionComplete = useCallback(
    (sessionId: string) => {
      setTerminalSessionIds((current) => {
        if (current.has(sessionId)) return current;
        const next = new Set(current);
        next.add(sessionId);
        return next;
      });
      onRefresh?.();
    },
    [onRefresh]
  );
  const isCompletedWorkItem = workItemStatus === COMPLETED_WORK_ITEM_STATUS;
  const runningLinkedSession = linkedSessions.find(
    (session) =>
      session.status === RUNNING_LINKED_SESSION_STATUS &&
      !terminalSessionIds.has(session.session_id)
  );
  const hasTerminalOnlyLinkedSessions =
    linkedSessions.length > 0 && !runningLinkedSession;
  const activeExecutionLockSessionId =
    isCompletedWorkItem || hasTerminalOnlyLinkedSessions
      ? null
      : (executionLock?.activeSessionId ?? null);
  const persistedActiveSessionId =
    activeExecutionLockSessionId ?? runningLinkedSession?.session_id ?? null;
  const canUseLocalActiveSession =
    workItemStatus === ACTIVE_WORK_ITEM_STATUS &&
    Boolean(activeAgentSessionId) &&
    !hasTerminalOnlyLinkedSessions;
  const displayActiveSessionId =
    persistedActiveSessionId ??
    (canUseLocalActiveSession ? activeAgentSessionId : null);
  const effectiveActiveSession = linkedSessions.find(
    (session) => session.session_id === displayActiveSessionId
  );
  const effectiveActiveAgentRole =
    toAgentRole(runningLinkedSession?.agent_role) ??
    activeAgentRole ??
    toAgentRole(effectiveActiveSession?.agent_role) ??
    null;
  const hasActiveAgentSession = Boolean(
    persistedActiveSessionId || canUseLocalActiveSession
  );
  const phase: OrchestratorPhase = (() => {
    if (hasActiveAgentSession && !ACTIVE_PHASES.has(persistedPhase)) {
      if (effectiveActiveAgentRole === AGENT_ROLE.Review) {
        return ORCHESTRATOR_PHASE.Review;
      }
      if (effectiveActiveAgentRole === AGENT_ROLE.FollowUp) {
        return ORCHESTRATOR_PHASE.FollowUp;
      }
      return ORCHESTRATOR_PHASE.Sde;
    }

    if (!hasActiveAgentSession && ACTIVE_PHASES.has(persistedPhase)) {
      return hasRuns ? ORCHESTRATOR_PHASE.Completed : ORCHESTRATOR_PHASE.Idle;
    }

    return persistedPhase;
  })();
  const { spinClass, handleClick: handleRefreshClick } = useRefreshSpin(
    onRefresh ?? (() => {}),
    false
  );

  const titleAction =
    phase !== "idle" && onRefresh ? (
      <WorkstationToolbarTooltip label={t("common:actions.refresh")}>
        <Button
          variant="tertiary"
          size="mini"
          icon={<RefreshCw size={12} className={spinClass} />}
          onClick={handleRefreshClick}
          aria-label={t("common:actions.refresh")}
        />
      </WorkstationToolbarTooltip>
    ) : undefined;

  const hasReviewFeedback = !!proofOfWork?.review_feedback;
  const reviewOutcome = proofOfWork?.review_feedback?.outcome;
  const showCompletedBadge =
    phase === "completed" &&
    !(hasReviewFeedback && reviewOutcome === "approved");

  return (
    <CollapsibleSection
      title={t("workItems.agentWorkflow.title")}
      defaultOpen={true}
      actions={titleAction}
    >
      <div
        className={`${SECTION_CONTAINER_CLASSES} space-y-2 p-3`}
        data-testid="work-item-agent-workflow"
      >
        {phase !== "idle" && (
          <PipelineStepper currentPhase={phase} cycleCount={cycleCount} />
        )}

        {phase === "idle" && (
          <IdleState
            orchestratorConfig={orchestratorConfig}
            executionLock={executionLock}
            onStartAgent={onStartAgent}
            isStartingAgent={isStartingAgent}
            isLockedByOther={isLockedByOther}
            lockHolderName={lockHolderName}
          />
        )}
        {ACTIVE_PHASES.has(phase) && (
          <ActivePhaseStatus phase={phase} onCancel={onCancel} />
        )}
        {showCompletedBadge && (
          <CompletedState
            orchestratorConfig={orchestratorConfig}
            executionLock={isCompletedWorkItem ? null : executionLock}
            onStartAgent={onStartAgent}
            isStartingAgent={isStartingAgent}
            isLockedByOther={isLockedByOther}
            lockHolderName={lockHolderName}
          />
        )}
        {phase === "failed" && (
          <FailedState
            orchestratorState={orchestratorState}
            onRetry={onRetry}
            onCancel={onCancel}
          />
        )}

        {phase !== "idle" && hasReviewFeedback && (
          <ReviewFeedbackPanel
            latestReview={proofOfWork.review_feedback}
            reviewHistory={proofOfWork.review_history}
            phase={phase}
            compact={phase === "completed"}
            onOpenSession={onOpenSession}
            onOpenFileAtLine={onOpenFileAtLine}
            onRetry={phase === "awaiting_user" ? onRetry : undefined}
            onAcceptAsIs={phase === "awaiting_user" ? onAcceptAsIs : undefined}
            onCreateFollowUp={
              phase === "awaiting_user" ? onCreateFollowUp : undefined
            }
            onCancel={phase === "awaiting_user" ? onCancel : undefined}
          />
        )}

        {phase === "awaiting_user" && !hasReviewFeedback && (
          <AwaitingUserState
            onRetry={onRetry}
            onCancel={onCancel}
            onAcceptAsIs={onAcceptAsIs}
            onCreateFollowUp={onCreateFollowUp}
          />
        )}
        {orchestratorState?.interrupted && (
          <InterruptedState onResume={onResume} onCancel={onCancel} />
        )}

        {(hasRuns || displayActiveSessionId) && (
          <SessionRunHistory
            sessionRuns={sessionRuns}
            subAgentsByParent={subAgentsByParent}
            activeAgentSessionId={displayActiveSessionId}
            activeAgentRole={effectiveActiveAgentRole}
            phase={phase}
            showOnlyActive={ACTIVE_PHASES.has(phase)}
            onOpenSession={onOpenSession}
            onRefresh={onRefresh}
            onSessionComplete={handleSessionComplete}
          />
        )}
      </div>
    </CollapsibleSection>
  );
};

export default AgentWorkflow;
