import { Check, Loader2, RotateCcw } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import type {
  OrchestratorConfig,
  OrchestratorPhase,
  OrchestratorState,
  WorkItemExecutionLock,
} from "@src/api/http/project";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import { ORCHESTRATOR_PHASE } from "../../constants";

interface IdleStateProps {
  orchestratorConfig?: OrchestratorConfig;
  executionLock?: WorkItemExecutionLock | null;
  onStartAgent?: (instructions?: string) => void;
  isStartingAgent?: boolean;
  /** Collab lock held by a teammate (design §16.6): disable + show holder. */
  isLockedByOther?: boolean;
  lockHolderName?: string | null;
}

export const IdleState: React.FC<IdleStateProps> = ({
  orchestratorConfig,
  executionLock,
  onStartAgent,
  isStartingAgent,
  isLockedByOther,
  lockHolderName,
}) => {
  const { t } = useTranslation("projects");

  const hasActiveExecutionLock = !!executionLock?.activeSessionId;
  const canStart =
    !!orchestratorConfig?.selected_account_id &&
    !!orchestratorConfig?.selected_model_id &&
    !isStartingAgent &&
    !hasActiveExecutionLock &&
    !isLockedByOther;

  const startLabel = isLockedByOther
    ? t("workItems.agentWorkflow.collabLockRunning", {
        name: lockHolderName ?? "",
      })
    : isStartingAgent
      ? t("workItems.agentWorkflow.running")
      : t("workItems.agentWorkflow.startAgent");

  return (
    <Placeholder
      variant="empty"
      title={t("workItems.agentWorkflow.noWorkflowRun")}
      placement="sidebar"
      action={
        onStartAgent
          ? {
              label: startLabel,
              onClick: () => onStartAgent(),
              variant: "primary",
              disabled: !canStart,
              dataTestId: "work-item-start-agent-button",
            }
          : undefined
      }
    />
  );
};

interface ActivePhaseStatusProps {
  phase: OrchestratorPhase;
  onCancel?: () => void;
}

export const ActivePhaseStatus: React.FC<ActivePhaseStatusProps> = ({
  phase,
  onCancel,
}) => {
  const { t } = useTranslation("projects");
  const phaseLabel =
    phase === ORCHESTRATOR_PHASE.Sde || phase === ORCHESTRATOR_PHASE.Coding
      ? t("workItems.agentWorkflow.sdePhase")
      : phase === ORCHESTRATOR_PHASE.Review
        ? t("workItems.agentWorkflow.reviewPhase")
        : t("workItems.agentWorkflow.followUpPhase");

  return (
    <div
      className="flex items-center justify-between rounded-md bg-fill-1 px-3 py-2"
      data-testid="work-item-agent-active-phase"
    >
      <div className="flex items-center gap-2">
        <Loader2 size={13} className="animate-spin text-primary-6" />
        <span className="text-xs font-medium text-text-1">{phaseLabel}</span>
        <span className="text-[11px] text-text-3">
          {t("workItems.agentWorkflow.running")}
        </span>
      </div>
      {onCancel && (
        <Button variant="tertiary" size="small" onClick={onCancel}>
          {t("common:actions.cancel")}
        </Button>
      )}
    </div>
  );
};

interface CompletedStateProps {
  orchestratorConfig?: OrchestratorConfig;
  executionLock?: WorkItemExecutionLock | null;
  onStartAgent?: (instructions?: string) => void;
  isStartingAgent?: boolean;
  /** Collab lock held by a teammate (design §16.6): disable + show holder. */
  isLockedByOther?: boolean;
  lockHolderName?: string | null;
}

export const CompletedState: React.FC<CompletedStateProps> = ({
  orchestratorConfig,
  executionLock,
  onStartAgent,
  isStartingAgent,
  isLockedByOther,
  lockHolderName,
}) => {
  const { t } = useTranslation("projects");

  const hasActiveExecutionLock = !!executionLock?.activeSessionId;
  const canStart =
    !!orchestratorConfig?.selected_account_id &&
    !!orchestratorConfig?.selected_model_id &&
    !isStartingAgent &&
    !hasActiveExecutionLock &&
    !isLockedByOther;

  const startLabel = isLockedByOther
    ? t("workItems.agentWorkflow.collabLockRunning", {
        name: lockHolderName ?? "",
      })
    : isStartingAgent
      ? t("workItems.agentWorkflow.running")
      : t("workItems.agentWorkflow.startAgent");

  return (
    <div
      className="flex items-center justify-between gap-2 rounded-md bg-fill-1 px-3 py-2"
      data-testid="work-item-agent-completed-state"
    >
      <div className="flex items-center gap-1.5">
        <div className="flex h-4 w-4 items-center justify-center rounded-full bg-success-6">
          <Check size={10} strokeWidth={3} className="text-white" />
        </div>
        <span className="text-xs font-medium text-text-1">
          {t("workItems.agentWorkflow.completed")}
        </span>
      </div>
      {onStartAgent && (
        <Button
          variant="primary"
          size="small"
          onClick={() => onStartAgent()}
          disabled={!canStart}
          data-testid="work-item-start-agent-button"
        >
          {startLabel}
        </Button>
      )}
    </div>
  );
};

interface FailedStateProps {
  orchestratorState?: OrchestratorState;
  onRetry?: () => void;
  onCancel?: () => void;
}

export const FailedState: React.FC<FailedStateProps> = ({
  orchestratorState,
  onRetry,
  onCancel,
}) => {
  const { t } = useTranslation("projects");
  const failure = orchestratorState?.last_failure;

  return (
    <div className="space-y-3">
      <InlineAlert
        type="danger"
        title={t("workItems.agentWorkflow.failedError")}
        action={
          <div className="flex gap-2">
            {onRetry && (
              <Button
                variant="primary"
                size="small"
                onClick={() => onRetry()}
                icon={<RotateCcw size={14} />}
              >
                {t("workItems.agentWorkflow.retry")}
              </Button>
            )}
            {onCancel && (
              <Button variant="tertiary" size="small" onClick={onCancel}>
                {t("common:actions.cancel")}
              </Button>
            )}
          </div>
        }
      >
        {failure?.reason && (
          <p className="text-xs text-text-3">{failure.reason}</p>
        )}
        {orchestratorState && orchestratorState.retry_count > 0 && (
          <p className="text-xs text-text-3">
            {t("workItems.agentWorkflow.retryWithContext")} (
            {orchestratorState.retry_count}/
            {orchestratorState.active_config?.max_retry_count ?? "?"})
          </p>
        )}
      </InlineAlert>
    </div>
  );
};

interface AwaitingUserStateProps {
  onRetry?: () => void;
  onCancel?: () => void;
  onAcceptAsIs?: () => void;
  onCreateFollowUp?: () => void;
}

export const AwaitingUserState: React.FC<AwaitingUserStateProps> = ({
  onRetry,
  onCancel,
  onAcceptAsIs,
  onCreateFollowUp,
}) => {
  const { t } = useTranslation("projects");

  return (
    <div className="rounded-md border border-border-1 bg-fill-1 px-3 py-2.5">
      <p className="mb-2 text-[11px] font-medium text-text-2">
        {t("workItems.agentWorkflow.whatNext")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {onRetry && (
          <Button variant="primary" size="small" onClick={() => onRetry()}>
            {t("workItems.agentWorkflow.fixAndRerun")}
          </Button>
        )}
        {onAcceptAsIs && (
          <Button
            variant="primary"
            appearance="outline"
            size="small"
            onClick={onAcceptAsIs}
          >
            {t("workItems.agentWorkflow.acceptAsIs")}
          </Button>
        )}
        {onCreateFollowUp && (
          <Button
            variant="primary"
            appearance="outline"
            size="small"
            onClick={onCreateFollowUp}
          >
            {t("workItems.agentWorkflow.createFollowUp")}
          </Button>
        )}
        {onCancel && (
          <Button variant="tertiary" size="small" onClick={onCancel}>
            {t("common:actions.cancel")}
          </Button>
        )}
      </div>
    </div>
  );
};

interface InterruptedStateProps {
  onResume?: () => void;
  onCancel?: () => void;
}

export const InterruptedState: React.FC<InterruptedStateProps> = ({
  onResume,
  onCancel,
}) => {
  const { t } = useTranslation("projects");

  return (
    <InlineAlert
      type="warning"
      title={t("workItems.agentWorkflow.interrupted")}
      action={
        <div className="flex gap-2">
          {onResume && (
            <Button variant="primary" size="small" onClick={onResume}>
              {t("workItems.agentWorkflow.resume")}
            </Button>
          )}
          {onCancel && (
            <Button variant="tertiary" size="small" onClick={onCancel}>
              {t("common:actions.cancel")}
            </Button>
          )}
        </div>
      }
    >
      {t("workItems.agentWorkflow.interruptedMessage")}
    </InlineAlert>
  );
};
