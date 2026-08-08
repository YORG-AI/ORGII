import {
  AlertTriangle,
  CheckCircle2,
  SquareArrowOutUpRight,
} from "lucide-react";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type {
  OrchestratorPhase,
  ReviewCommentSeverity,
  ReviewFeedback,
} from "@src/api/http/project";
import Button from "@src/components/Button";
import { CommentRow } from "@src/components/CodeReviewBlocks";

import CollapsibleSummary from "./CollapsibleSummary";
import IterationHistory from "./IterationHistory";
import SeverityPills from "./SeverityPills";

interface ReviewFeedbackPanelProps {
  latestReview?: ReviewFeedback;
  reviewHistory?: ReviewFeedback[];
  phase: OrchestratorPhase;
  compact?: boolean;
  onOpenSession?: (sessionId: string) => void;
  onOpenFileAtLine?: (filePath: string, line?: number) => void;
  onRetry?: () => void;
  onAcceptAsIs?: () => void;
  onCreateFollowUp?: () => void;
  onCancel?: () => void;
}

const OUTCOME_STYLES = {
  approved: {
    headerIcon: <CheckCircle2 size={15} className="text-success-6" />,
    headerText: "text-text-1",
  },
  changes_requested: {
    headerIcon: <AlertTriangle size={15} className="text-warning-6" />,
    headerText: "text-text-1",
  },
  inconclusive: {
    headerIcon: <AlertTriangle size={15} className="text-text-3" />,
    headerText: "text-text-1",
  },
} as const;

const SEVERITY_ORDER: ReviewCommentSeverity[] = [
  "error",
  "warning",
  "suggestion",
  "praise",
];

const ReviewFeedbackPanel: React.FC<ReviewFeedbackPanelProps> = ({
  latestReview,
  reviewHistory = [],
  phase,
  compact = false,
  onOpenSession,
  onOpenFileAtLine,
  onRetry,
  onAcceptAsIs,
  onCreateFollowUp,
  onCancel,
}) => {
  const { t } = useTranslation("projects");

  const severityCounts = useMemo(() => {
    const counts: Partial<Record<ReviewCommentSeverity, number>> = {};
    for (const comment of latestReview?.comments ?? []) {
      counts[comment.severity] = (counts[comment.severity] ?? 0) + 1;
    }
    return counts;
  }, [latestReview?.comments]);

  const sortedComments = useMemo(() => {
    const comments = latestReview?.comments ?? [];
    if (comments.length === 0) return [];
    return [...comments].sort((commentA, commentB) => {
      const orderA = SEVERITY_ORDER.indexOf(commentA.severity);
      const orderB = SEVERITY_ORDER.indexOf(commentB.severity);
      return orderA - orderB;
    });
  }, [latestReview?.comments]);

  if (!latestReview) return null;

  const outcome = latestReview.outcome ?? "inconclusive";
  const isDuringSdeRerun = phase === "sde" && reviewHistory.length > 0;
  const isAwaitingUser = phase === "awaiting_user";

  const headerLabel = isDuringSdeRerun
    ? t("workItems.reviewFeedback.previousReview")
    : outcome === "approved"
      ? t("workItems.reviewFeedback.approved")
      : outcome === "inconclusive"
        ? t("workItems.reviewFeedback.inconclusive")
        : t("workItems.reviewFeedback.changesRequested");

  const style =
    OUTCOME_STYLES[outcome as keyof typeof OUTCOME_STYLES] ??
    OUTCOME_STYLES.inconclusive;

  if (compact) {
    return (
      <div className="flex items-center gap-2 rounded-md bg-fill-1 px-3 py-2.5">
        {style.headerIcon}
        <span className={`text-[13px] font-semibold ${style.headerText}`}>
          {headerLabel}
        </span>
        <SeverityPills counts={severityCounts} />
      </div>
    );
  }

  return (
    <div className="rounded-md bg-fill-1">
      <div className="flex items-center justify-between px-3 py-3">
        <div className="flex items-center gap-2.5">
          {style.headerIcon}
          <span className={`text-[13px] font-semibold ${style.headerText}`}>
            {headerLabel}
          </span>
          <SeverityPills counts={severityCounts} />
        </div>
        {onOpenSession && latestReview.session_id && (
          <Button
            variant="tertiary"
            size="mini"
            icon={<SquareArrowOutUpRight size={11} />}
            onClick={() => onOpenSession(latestReview.session_id)}
            title={t("workItems.agentWorkflow.openSession")}
          />
        )}
      </div>

      {latestReview.summary && (
        <div className="mx-3 border-t border-border-2 pt-2">
          <CollapsibleSummary content={latestReview.summary} />
        </div>
      )}

      {sortedComments.length > 0 && (
        <div className="mx-3 border-t border-border-2 py-1.5">
          {sortedComments.map((comment, idx) => (
            <CommentRow
              key={idx}
              comment={comment}
              onOpenFileAtLine={onOpenFileAtLine}
            />
          ))}
        </div>
      )}

      {isDuringSdeRerun && (
        <div className="mx-3 border-t border-border-2 px-0 py-1.5 text-[10px] text-text-4">
          {t("workItems.reviewFeedback.sdeAddressing")}
        </div>
      )}

      {isAwaitingUser && (
        <div className="mx-3 border-t border-border-2 px-0 py-2.5">
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
      )}

      {reviewHistory.length > 0 && !isDuringSdeRerun && (
        <IterationHistory
          history={reviewHistory}
          latestResolutions={latestReview.resolved_from_previous ?? []}
          onOpenSession={onOpenSession}
          onOpenFileAtLine={onOpenFileAtLine}
        />
      )}
    </div>
  );
};

export default ReviewFeedbackPanel;
