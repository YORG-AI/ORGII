import { FilePenLine } from "lucide-react";
import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type AgentOrgPlanApproval,
  respondAgentOrgPlanApproval,
} from "@src/api/tauri/agent";
import Button from "@src/components/Button";
import Markdown from "@src/components/MarkDown";
import Textarea from "@src/components/Textarea";

interface AgentOrgPlanApprovalCardProps {
  approval: AgentOrgPlanApproval;
  sourceMemberName: string;
  sessionId: string;
  disabled: boolean;
  onResolved: () => Promise<void>;
}

const AgentOrgPlanApprovalCard: React.FC<AgentOrgPlanApprovalCardProps> = memo(
  ({ approval, sourceMemberName, sessionId, disabled, onResolved }) => {
    const { t } = useTranslation("sessions");
    const [mode, setMode] = useState<"preview" | "edit" | "feedback">(
      "preview"
    );
    const [content, setContent] = useState(approval.planContent);
    const [feedback, setFeedback] = useState("");
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = useCallback(
      async (
        decision: "approve" | "approve_with_edits" | "request_changes"
      ) => {
        if (submitting || disabled) return;
        setSubmitting(true);
        setError(null);
        try {
          await respondAgentOrgPlanApproval({
            sessionId,
            approvalId: approval.approvalId,
            planRevisionId: approval.planRevisionId,
            decision,
            editedContent: decision === "approve_with_edits" ? content : null,
            feedback: decision === "request_changes" ? feedback : null,
          });
          await onResolved();
        } catch (nextError: unknown) {
          setError(
            nextError instanceof Error ? nextError.message : String(nextError)
          );
        } finally {
          setSubmitting(false);
        }
      },
      [
        approval.approvalId,
        approval.planRevisionId,
        content,
        disabled,
        feedback,
        onResolved,
        sessionId,
        submitting,
      ]
    );

    return (
      <div
        className="rounded-md border border-solid border-border-2 bg-bg-1 p-3"
        data-testid="agent-org-plan-approval-card"
        data-approval-id={approval.approvalId}
      >
        <div className="mb-2 flex items-start gap-2">
          <FilePenLine className="mt-0.5 shrink-0 text-text-3" size={14} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-text-1">
              {approval.planTitle}
            </div>
            <div className="text-[11px] text-text-3">
              {t("planner.agentOrgOverview.planApproval.from", {
                member: sourceMemberName,
              })}
            </div>
          </div>
        </div>

        {mode === "edit" ? (
          <Textarea
            value={content}
            onChange={setContent}
            rows={8}
            autoSize={{ minRows: 8, maxRows: 18 }}
            disabled={submitting || disabled}
            aria-label={t("planner.agentOrgOverview.planApproval.editLabel")}
            data-testid="agent-org-plan-approval-edit"
          />
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
            <Markdown textContent={approval.planContent} skipPreprocess />
          </div>
        )}

        {error ? (
          <div className="text-error-6 mt-2 text-xs" role="alert">
            {error}
          </div>
        ) : null}
        {disabled ? (
          <div className="mt-2 text-[11px] text-text-3">
            {t("planner.agentOrgOverview.planApproval.paused")}
          </div>
        ) : null}

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
            <>
              <Button
                variant="tertiary"
                size="mini"
                disabled={submitting || disabled}
                onClick={() => setMode("feedback")}
                data-testid="agent-org-plan-request-changes-button"
              >
                {t("planner.agentOrgOverview.planApproval.requestChanges")}
              </Button>
              <Button
                variant="secondary"
                size="mini"
                disabled={submitting || disabled}
                onClick={() => setMode("edit")}
                data-testid="agent-org-plan-edit-button"
              >
                {t("common:actions.edit")}
              </Button>
            </>
          )}
          {mode === "feedback" ? (
            <Button
              variant="primary"
              size="mini"
              disabled={submitting || disabled || feedback.trim().length === 0}
              loading={submitting}
              onClick={() => void submit("request_changes")}
              data-testid="agent-org-plan-send-feedback-button"
            >
              {t("planner.agentOrgOverview.planApproval.sendFeedback")}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="mini"
              disabled={submitting || disabled || content.trim().length === 0}
              loading={submitting}
              onClick={() =>
                void submit(mode === "edit" ? "approve_with_edits" : "approve")
              }
              data-testid="agent-org-plan-approve-button"
            >
              {mode === "edit"
                ? t("planner.agentOrgOverview.planApproval.approveEdits")
                : t("planner.agentOrgOverview.planApproval.approve")}
            </Button>
          )}
        </div>
      </div>
    );
  }
);

AgentOrgPlanApprovalCard.displayName = "AgentOrgPlanApprovalCard";

export default AgentOrgPlanApprovalCard;
