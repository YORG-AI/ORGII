import React from "react";
import { useTranslation } from "react-i18next";

import type { OrchestratorPhase } from "@src/api/http/project";
import ChangedFilesList from "@src/modules/ProjectManager/WorkItems/components/AgentWorkflow/ChangedFilesList";
import ReviewFeedbackPanel from "@src/modules/ProjectManager/WorkItems/components/AgentWorkflow/ReviewFeedbackPanel";
import { CollapsibleSection } from "@src/modules/shared/layouts/blocks";

import PrSection from "./PrSection";
import { useLiveDiffStats } from "./hooks/useLiveDiffStats";
import type { OutputTabContentProps } from "./types";

const OutputTab: React.FC<OutputTabContentProps> = ({
  workItem,
  repoPath,
  onOpenFileDiff,
  onOpenFileAtLine,
  onReviewAllFiles,
  onOpenSession,
  onRetry,
  onAcceptAsIs,
  onCreateFollowUp,
  onCancel,
  onCreatePr,
}) => {
  const { t } = useTranslation("projects");
  const phase: OrchestratorPhase =
    workItem.orchestratorState?.current_phase ?? "idle";
  const proofOfWork = workItem.proofOfWork;
  const isLiveSde = phase === "sde";

  const liveDiffStats = useLiveDiffStats({
    sessionId: workItem.session_id,
    repoPath,
    branch: proofOfWork?.branch,
    isLive: isLiveSde,
  });

  const effectiveDiffStats =
    isLiveSde && liveDiffStats ? liveDiffStats : proofOfWork?.diff_stats;

  const hasChangedFiles =
    (effectiveDiffStats?.files_changed ?? 0) > 0 ||
    (effectiveDiffStats?.files?.length ?? 0) > 0;

  return (
    <>
      <CollapsibleSection
        title={t("workItems.outputTab.prSection")}
        defaultOpen={true}
      >
        <PrSection
          key={workItem.session_id}
          prUrl={proofOfWork?.pr_url}
          prStatus={proofOfWork?.pr_status}
          branch={proofOfWork?.branch}
          phase={phase}
          autoCreatePr={workItem.orchestratorConfig?.auto_create_pr ?? true}
          onCreatePr={onCreatePr}
        />
      </CollapsibleSection>

      <CollapsibleSection
        title={t("workItems.outputTab.changedFilesSection")}
        defaultOpen={true}
      >
        {hasChangedFiles ? (
          <ChangedFilesList
            diffStats={effectiveDiffStats}
            reviewComments={proofOfWork?.review_feedback?.comments}
            isLive={isLiveSde}
            onOpenFileDiff={onOpenFileDiff}
            onReviewAllFiles={onReviewAllFiles}
          />
        ) : (
          <div className="rounded-md bg-fill-2 px-4 py-3">
            <p className="text-sm text-text-2">
              {t("workItems.outputTab.fileDiffClean")}
            </p>
            <p className="mt-0.5 text-xs text-text-4">
              {t("workItems.outputTab.fileDiffCleanHint")}
            </p>
          </div>
        )}
      </CollapsibleSection>

      {proofOfWork?.review_feedback && (
        <CollapsibleSection
          title={t("workItems.agentWorkflow.reviewPhase")}
          defaultOpen={true}
        >
          <ReviewFeedbackPanel
            latestReview={proofOfWork.review_feedback}
            reviewHistory={proofOfWork.review_history}
            phase={phase}
            onOpenSession={onOpenSession}
            onOpenFileAtLine={onOpenFileAtLine}
            onRetry={phase === "awaiting_user" ? onRetry : undefined}
            onAcceptAsIs={phase === "awaiting_user" ? onAcceptAsIs : undefined}
            onCreateFollowUp={
              phase === "awaiting_user" ? onCreateFollowUp : undefined
            }
            onCancel={phase === "awaiting_user" ? onCancel : undefined}
          />
        </CollapsibleSection>
      )}

      {proofOfWork &&
        (proofOfWork.total_cost_usd > 0 || proofOfWork.total_tokens > 0) && (
          <CollapsibleSection
            title={t("workItems.outputTab.costSummary")}
            defaultOpen={true}
          >
            <div className="rounded-md bg-fill-1 px-4 py-2.5 text-xs text-text-3">
              {t("workItems.outputTab.totalCost")}: $
              {proofOfWork.total_cost_usd.toFixed(4)} &middot;{" "}
              {proofOfWork.total_tokens.toLocaleString()}{" "}
              {t("workItems.outputTab.tokens")}
            </div>
          </CollapsibleSection>
        )}
    </>
  );
};

export default OutputTab;
