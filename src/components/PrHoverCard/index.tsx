import { Clock, FileDiff, GitBranch, GitPullRequest } from "lucide-react";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import HoverCardBase, {
  HoverCardPanel,
  type HoverCardPosition,
  HoverCardRow,
} from "@src/components/SessionHoverCard/HoverCardBase";
import { HoverCardUrlRow } from "@src/components/SessionHoverCard/HoverCardUrlRow";
import { formatHoverCardTimeAgo } from "@src/components/SessionHoverCard/hoverCardTime";
import {
  getPrStatusLabelKey,
  getPrStatusVariant,
} from "@src/shared/pr/prStatus";

export interface PrHoverCardData {
  number: number;
  url?: string;
  title: string;
  state: string;
  head_branch?: string;
  base_branch?: string;
  draft?: boolean;
  additions?: number | null;
  deletions?: number | null;
  updated_at?: string;
}

interface PrHoverCardProps {
  pr?: PrHoverCardData | null;
  children: React.ReactElement;
  position?: HoverCardPosition;
  mouseEnterDelay?: number;
  mouseLeaveDelay?: number;
}

interface PrHoverCardContentProps {
  pr: PrHoverCardData;
}

function truncateBranchLabel(branch: string, max = 80): string {
  const trimmed = branch.trim();
  if (trimmed.length <= max) return trimmed;
  if (max <= 1) return "…";
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

const PrHoverCardContent: React.FC<PrHoverCardContentProps> = memo(({ pr }) => {
  const { i18n, t } = useTranslation("common");
  const statusKey = pr.draft ? "draft" : pr.state;
  const statusVariant = getPrStatusVariant(statusKey);
  const statusIconClassName = statusVariant.dotClass.replace("bg-", "text-");
  const branchLabel = pr.head_branch
    ? truncateBranchLabel(pr.head_branch)
    : null;
  const additions = pr.additions ?? 0;
  const deletions = pr.deletions ?? 0;
  const hasDiffStats = additions > 0 || deletions > 0;

  return (
    <HoverCardPanel title={pr.title}>
      <HoverCardRow
        icon={<GitPullRequest size={13} strokeWidth={1.75} />}
        iconClassName={statusIconClassName}
      >
        <div className="truncate text-text-2">
          <span>{t(getPrStatusLabelKey(statusKey), statusKey)}</span>
          <span className="mx-1 text-text-4">·</span>
          <span>#{pr.number}</span>
        </div>
      </HoverCardRow>

      {pr.url && <HoverCardUrlRow url={pr.url} />}

      {branchLabel && (
        <HoverCardRow icon={<GitBranch size={13} strokeWidth={1.75} />}>
          <div className="truncate text-text-2" title={pr.head_branch}>
            <span>{branchLabel}</span>
            {pr.base_branch && (
              <>
                <span className="mx-1 text-text-4">·</span>
                <span className="text-text-3">{pr.base_branch}</span>
              </>
            )}
          </div>
        </HoverCardRow>
      )}

      {hasDiffStats && (
        <HoverCardRow icon={<FileDiff size={13} strokeWidth={1.75} />}>
          <div
            className="flex min-w-0 items-center"
            data-testid="pr-hover-card-diff-stats"
          >
            <span className="text-text-3">
              {t("git.pr.tabs.changes", { defaultValue: "Changes" })}
            </span>
            <span className="mx-1 text-text-4">·</span>
            <DiffStatsBadge
              additions={additions}
              deletions={deletions}
              variant="plain"
              size="md"
              weight="normal"
              reserveValueWidth={false}
            />
          </div>
        </HoverCardRow>
      )}

      {pr.updated_at && (
        <HoverCardRow icon={<Clock size={13} strokeWidth={1.75} />}>
          <div className="truncate text-text-2">
            <span className="text-text-3">
              {t("git.issues.updated", { defaultValue: "Last updated" })}
            </span>
            <span className="mx-1 text-text-4">·</span>
            <span>{formatHoverCardTimeAgo(pr.updated_at, i18n.language)}</span>
          </div>
        </HoverCardRow>
      )}
    </HoverCardPanel>
  );
});

PrHoverCardContent.displayName = "PrHoverCardContent";

const PrHoverCard: React.FC<PrHoverCardProps> = ({
  pr,
  children,
  position = "right-start",
  mouseEnterDelay,
  mouseLeaveDelay,
}) => {
  const renderContent = useCallback(
    () => (pr ? <PrHoverCardContent pr={pr} /> : null),
    [pr]
  );

  return (
    <HoverCardBase
      cardId={pr ? `github-pr:${pr.number}` : null}
      position={position}
      mouseEnterDelay={mouseEnterDelay}
      mouseLeaveDelay={mouseLeaveDelay}
      renderContent={renderContent}
    >
      {children}
    </HoverCardBase>
  );
};

export default PrHoverCard;
