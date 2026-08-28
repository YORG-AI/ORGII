import React from "react";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import PrStatusBadge from "@src/components/PrStatusBadge";
import { HugeiconsIcon, SquareArrowUpRightIcon } from "@src/icons";
import { formatStatNumber } from "@src/shared/pr/formatStatNumber";

import { ToolResultCardFrameLink } from "./ToolResultCardFrame";

export interface SessionLinkCardData {
  prUrl: string;
  prStatus: "draft" | "open" | "merged" | "closed";
  repoFullName: string;
  prNumber: number;
  prTitle: string;
  sourceBranch?: string;
  targetBranch?: string;
  filesChanged?: number;
  additions?: number;
  deletions?: number;
}

interface SessionLinkCardProps {
  card: SessionLinkCardData;
}

const SessionLinkCard: React.FC<SessionLinkCardProps> = ({ card }) => {
  return (
    <ToolResultCardFrameLink
      href={card.prUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="block cursor-pointer"
      aria-label={`PR #${card.prNumber}: ${card.prTitle}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-center gap-2">
            <PrStatusBadge status={card.prStatus} showIcon />
            <span className="truncate text-xs text-text-3">
              {card.repoFullName}
            </span>
            <span className="shrink-0 text-xs text-text-4">
              #{card.prNumber}
            </span>
          </div>

          <span className="chat-block-content truncate font-medium text-text-1">
            {card.prTitle}
          </span>

          {(card.sourceBranch ||
            card.filesChanged !== undefined ||
            card.additions !== undefined ||
            card.deletions !== undefined) && (
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-text-4">
              {card.sourceBranch && (
                <span className="truncate font-mono text-[11px]">
                  {card.sourceBranch}
                  {card.targetBranch && (
                    <span className="text-text-4"> → {card.targetBranch}</span>
                  )}
                </span>
              )}
              {card.filesChanged !== undefined && (
                <>
                  {card.sourceBranch && <span>·</span>}
                  <span className="shrink-0">
                    {formatStatNumber(card.filesChanged)} files
                  </span>
                </>
              )}
              {(card.additions !== undefined ||
                card.deletions !== undefined) && (
                <>
                  {(card.sourceBranch || card.filesChanged !== undefined) && (
                    <span>·</span>
                  )}
                  <DiffStatsBadge
                    additions={card.additions}
                    deletions={card.deletions}
                    variant="plain"
                    formatValue={formatStatNumber}
                  />
                </>
              )}
            </div>
          )}
        </div>

        <HugeiconsIcon
          icon={SquareArrowUpRightIcon}
          data-icon="square-arrow-out-up-right"
          size={13}
          className="mt-0.5 shrink-0 text-text-4 transition-colors hover:text-text-2"
          aria-hidden="true"
        />
      </div>
    </ToolResultCardFrameLink>
  );
};

SessionLinkCard.displayName = "SessionLinkCard";

export default SessionLinkCard;
