import { ChevronDown, ChevronRight, SquareArrowOutUpRight } from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ReviewFeedback } from "@src/api/http/project";
import Button from "@src/components/Button";
import { CommentRow } from "@src/components/CodeReviewBlocks";

interface IterationHistoryProps {
  history: ReviewFeedback[];
  latestResolutions: {
    round: number;
    comment_index: number;
    status: string;
  }[];
  onOpenSession?: (sessionId: string) => void;
  onOpenFileAtLine?: (filePath: string, line?: number) => void;
}

const IterationHistory: React.FC<IterationHistoryProps> = ({
  history,
  latestResolutions,
  onOpenSession,
  onOpenFileAtLine,
}) => {
  const { t } = useTranslation("projects");
  const [expandedRound, setExpandedRound] = useState<number | null>(null);

  const resolutionMap = useMemo(() => {
    const resMap = new Map<string, string>();
    for (const resolution of latestResolutions) {
      const key = `${resolution.round}-${resolution.comment_index}`;
      resMap.set(key, resolution.status.toUpperCase());
    }
    return resMap;
  }, [latestResolutions]);

  return (
    <div className="mx-3 border-t border-border-2">
      <div className="px-0 py-1.5 text-[10px] font-medium text-text-4">
        {t("workItems.reviewFeedback.iterationHistory", {
          count: history.length,
        })}
      </div>
      {history.map((round, idx) => {
        const roundNumber = idx + 1;
        const isExpanded = expandedRound === roundNumber;
        const roundComments = round.comments ?? [];
        const issueCount = roundComments.filter(
          (comment) =>
            comment.severity === "error" || comment.severity === "warning"
        ).length;
        const fixedCount = roundComments.filter((_comment, commentIdx) =>
          resolutionMap.has(`${roundNumber}-${commentIdx}`)
        ).length;

        return (
          <div key={roundNumber} className="border-t border-border-2">
            <button
              className="flex w-full items-center gap-2 rounded px-0 py-1.5 text-left transition-colors hover:bg-fill-2"
              onClick={() => setExpandedRound(isExpanded ? null : roundNumber)}
            >
              {isExpanded ? (
                <ChevronDown size={12} className="text-text-4" />
              ) : (
                <ChevronRight size={12} className="text-text-4" />
              )}
              <span className="text-[11px] text-text-2">
                {t("workItems.reviewFeedback.reviewRound", {
                  round: roundNumber,
                })}{" "}
                —{" "}
                {round.outcome === "approved"
                  ? t("workItems.reviewFeedback.outcomeApproved")
                  : t("workItems.reviewFeedback.outcomeChangesRequested")}
                {issueCount > 0 &&
                  ` (${t("workItems.reviewFeedback.issueCount", { count: issueCount })}${fixedCount > 0 ? `, ${t("workItems.reviewFeedback.fixedCount", { count: fixedCount })}` : ""})`}
              </span>
              {onOpenSession && (
                <Button
                  variant="tertiary"
                  size="mini"
                  icon={<SquareArrowOutUpRight size={10} />}
                  className="ml-auto"
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenSession(round.session_id);
                  }}
                />
              )}
            </button>

            {isExpanded && (
              <div className="pb-2 pl-4">
                <p className="mb-1 text-[10px] italic text-text-3">
                  {t("workItems.reviewFeedback.archived")}
                </p>
                {(round.comments ?? []).map((comment, commentIdx) => {
                  const resKey = `${roundNumber}-${commentIdx}`;
                  const resStatus = resolutionMap.get(resKey);
                  return (
                    <CommentRow
                      key={commentIdx}
                      comment={comment}
                      resolved={resStatus}
                      onOpenFileAtLine={onOpenFileAtLine}
                    />
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

export default IterationHistory;
