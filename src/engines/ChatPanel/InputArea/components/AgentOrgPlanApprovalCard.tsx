import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type AgentOrgPlanApprovalSummary,
  respondAgentOrgPlanApproval,
} from "@src/api/tauri/agent";
import Button from "@src/components/Button";
import Markdown from "@src/components/MarkDown";
import Textarea from "@src/components/Textarea";
import { createLogger } from "@src/hooks/logger";
import { Edit04Icon, HugeiconsIcon } from "@src/icons";

import { useAgentOrgPlanApprovalDetail } from "./useAgentOrgPlanApprovalDetail";

const logger = createLogger("AgentOrgPlanApprovalCard");

interface AgentOrgPlanApprovalCardProps {
  approval: AgentOrgPlanApprovalSummary;
  sourceMemberName: string;
  sessionId: string;
  disabled: boolean;
  onResolved: () => Promise<void>;
}

const AgentOrgPlanApprovalCard: React.FC<AgentOrgPlanApprovalCardProps> = memo(
  ({ approval, sourceMemberName, sessionId, disabled, onResolved }) => {
    const { t } = useTranslation("sessions");
    const canRespond =
      approval.policy === "user" && approval.status === "pending";
    const [mode, setMode] = useState<"preview" | "feedback">("preview");
    const [expanded, setExpanded] = useState(canRespond);
    const {
      detail,
      error: loadError,
      loading,
      retry,
    } = useAgentOrgPlanApprovalDetail(sessionId, approval, expanded);
    const [feedback, setFeedback] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = useCallback(
      async (decision: "approve" | "request_changes") => {
        if (submitting || disabled || !detail) return;
        setSubmitting(true);
        setError(null);
        try {
          await respondAgentOrgPlanApproval({
            sessionId,
            approvalId: approval.approvalId,
            planRevisionId: approval.planRevisionId,
            sourceTaskId: approval.sourceTaskId,
            sourceTurnIntentId: approval.sourceTurnIntentId,
            decision,
            feedback: decision === "request_changes" ? feedback : null,
          });
          await onResolved();
        } catch (nextError: unknown) {
          const rawError =
            nextError instanceof Error ? nextError.message : String(nextError);
          logger.error(
            "Failed to respond to Agent Org plan approval:",
            nextError
          );
          setError(
            rawError.includes("agent_org_plan_approval_stale_revision")
              ? t("planner.agentOrgOverview.planApproval.staleError")
              : t("planner.agentOrgOverview.planApproval.submitFailed")
          );
        } finally {
          setSubmitting(false);
        }
      },
      [
        approval.approvalId,
        approval.planRevisionId,
        approval.sourceTaskId,
        approval.sourceTurnIntentId,
        detail,
        disabled,
        feedback,
        onResolved,
        sessionId,
        submitting,
        t,
      ]
    );
    return (
      <div
        className="rounded-md border border-solid border-border-2 bg-bg-1 p-3"
        data-testid="agent-org-plan-approval-card"
        data-approval-id={approval.approvalId}
      >
        <div className="mb-2 flex items-start gap-2">
          <HugeiconsIcon
            icon={Edit04Icon}
            data-icon="file-pen-line"
            className="mt-0.5 shrink-0 text-text-3"
            size={14}
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-text-1">
              {approval.planTitle}
            </div>
            <div className="text-[11px] text-text-3">
              {t("planner.agentOrgOverview.planApproval.from", {
                member: sourceMemberName,
              })}
            </div>
            <div
              className="mt-1 inline-flex rounded-full bg-bg-2 px-1.5 py-0.5 text-[10px] text-text-2"
              data-testid="agent-org-plan-revision-status"
              data-plan-status={approval.status}
            >
              {t(
                `planner.agentOrgOverview.planApproval.status.${approval.status}`,
                { defaultValue: approval.status.replace(/_/g, " ") }
              )}
            </div>
          </div>
        </div>

        {!expanded ? (
          <Button
            variant="tertiary"
            size="mini"
            onClick={() => setExpanded(true)}
            data-testid="agent-org-plan-revision-open"
          >
            {t("planner.agentOrgOverview.planApproval.open", {
              defaultValue: "Open plan",
            })}
          </Button>
        ) : loading ? (
          <div
            className="rounded-md bg-bg-2 p-2 text-xs text-text-3"
            data-testid="agent-org-plan-approval-loading"
          >
            {t("common:status.loading", { defaultValue: "Loading plan…" })}
          </div>
        ) : loadError ? (
          <div className="rounded-md bg-bg-2 p-2" role="alert">
            <div className="text-error-6 text-xs">{loadError}</div>
            <Button
              variant="tertiary"
              size="mini"
              className="mt-2"
              onClick={() => void retry()}
              data-testid="agent-org-plan-approval-retry"
            >
              {t("common:actions.retry", { defaultValue: "Retry" })}
            </Button>
          </div>
        ) : mode === "feedback" ? (
          <Textarea
            value={feedback}
            onChange={setFeedback}
            placeholder={t(
              "planner.agentOrgOverview.planApproval.feedbackPlaceholder"
            )}
            rows={3}
            autoSize={{ minRows: 3, maxRows: 8 }}
            disabled={submitting || disabled}
            aria-label={t(
              "planner.agentOrgOverview.planApproval.feedbackLabel"
            )}
            data-testid="agent-org-plan-approval-feedback"
          />
        ) : (
          <div className="max-h-64 overflow-auto rounded-md bg-bg-2 p-2 text-xs">
            <Markdown textContent={detail?.planContent ?? ""} skipPreprocess />
          </div>
        )}

        {approval.feedback ? (
          <div
            className="mt-2 rounded-md bg-bg-2 p-2 text-xs text-text-2"
            data-testid="agent-org-plan-revision-feedback"
          >
            {approval.feedback}
          </div>
        ) : null}
        {approval.taskOutput ? (
          <div
            className="mt-2 text-[11px] text-text-3"
            data-testid="agent-org-plan-revision-task-output"
          >
            {t("planner.agentOrgOverview.planApproval.taskOutput", {
              defaultValue: "Planning Task output saved",
            })}
          </div>
        ) : null}

        {error ? (
          <div className="text-error-6 mt-2 text-xs" role="alert">
            {error}
          </div>
        ) : null}
        {canRespond && disabled ? (
          <div className="mt-2 text-[11px] text-text-3">
            {t("planner.agentOrgOverview.planApproval.paused")}
          </div>
        ) : null}

        {canRespond ? (
          <div className="mt-3 flex flex-wrap justify-end gap-1.5">
            {mode !== "preview" ? (
              <Button
                variant="tertiary"
                size="mini"
                disabled={submitting}
                onClick={() => setMode("preview")}
              >
                {t("common:actions.cancel")}
              </Button>
            ) : (
              <Button
                variant="tertiary"
                size="mini"
                disabled={submitting || disabled || !detail}
                onClick={() => setMode("feedback")}
                data-testid="agent-org-plan-request-changes-button"
              >
                {t("planner.agentOrgOverview.planApproval.requestChanges")}
              </Button>
            )}
            {mode === "feedback" ? (
              <Button
                variant="primary"
                size="mini"
                disabled={
                  submitting ||
                  disabled ||
                  !detail ||
                  feedback.trim().length === 0
                }
                loading={submitting}
                onClick={() => void submit("request_changes")}
                data-testid="agent-org-plan-send-feedback-button"
              >
                {t("planner.agentOrgOverview.planApproval.sendFeedback")}
              </Button>
            ) : mode === "preview" ? (
              <Button
                variant="primary"
                size="mini"
                disabled={submitting || disabled || !detail}
                loading={submitting}
                onClick={() => void submit("approve")}
                data-testid="agent-org-plan-approve-button"
              >
                {t("planner.agentOrgOverview.planApproval.approve")}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }
);

AgentOrgPlanApprovalCard.displayName = "AgentOrgPlanApprovalCard";

export default AgentOrgPlanApprovalCard;
