import {
  Clock,
  Eye,
  GitBranch,
  GitFork,
  MessageSquare,
  Pin,
  Users,
} from "lucide-react";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import ModelIcon from "@src/components/ModelIcon";
import { resolveAgentIcon } from "@src/config/agentIcons";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import {
  formatReplayDateLabel,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";
import { formatBranchLabel } from "@src/util/git/branchLabel";
import { basename } from "@src/util/path";
import {
  type SessionDisplayMetadata,
  resolveSessionDisplayMetadata,
} from "@src/util/session/sessionDisplayMetadata";

import HoverCardBase, {
  HoverCardPanel,
  type HoverCardPosition,
  HoverCardRow,
} from "./HoverCardBase";

/**
 * Hover metadata card for "Team sessions" rows (cloudremote-* sidebar ids).
 * Local sessions render SessionHoverCard from the session store; teammate
 * rows carry pushed RemoteTeammateSessionMetadata plus live viewer data from
 * the sidebar connector. The card makes no store lookup or fetches itself.
 */
interface CloudSessionHoverCardContentProps {
  row: RemoteTeammateSessionMetadata;
  viewers?: readonly { displayName: string }[];
}

function renderAgentIcon(display: SessionDisplayMetadata) {
  const AgentIcon = resolveAgentIcon(display.agentIconId);
  return <AgentIcon size={13} strokeWidth={1.75} />;
}

export const CloudSessionHoverCardContent: React.FC<CloudSessionHoverCardContentProps> =
  memo(({ row, viewers = [] }) => {
    const { t, i18n } = useTranslation(["navigation", "sessions", "common"]);
    const display = resolveSessionDisplayMetadata({
      kind: "remote",
      session: row,
    });
    const repoName = row.repoScopeKey
      ? basename(row.repoScopeKey)
      : row.repoPath
        ? basename(row.repoPath)
        : "";
    const branchLabel = formatBranchLabel(row.branch);
    const lastActivityLabel = row.lastActivityAt
      ? formatReplayDateLabel(row.lastActivityAt, {
          todayLabel: t("common:relativeDate.today"),
          yesterdayLabel: t("common:relativeDate.yesterday"),
          locale: toIntlLocaleTag(i18n.language),
          monthStyle: "short",
          withSeconds: false,
        })
      : "";
    const unresolvedComments = row.unresolvedCommentCount ?? 0;
    const viewerNames = viewers
      .map((viewer) => viewer.displayName)
      .filter(Boolean)
      .join(", ");

    return (
      // Fork provenance renders as the lineage row below — drop the fork
      // glyph(s) baked into pushed titles rather than doubling them here.
      <HoverCardPanel title={row.title.replace(/^(?:⑂\s*)+/u, "")}>
        <HoverCardRow icon={<Users size={13} strokeWidth={1.75} />}>
          <div
            className="truncate text-text-2"
            title={`${t("navigation:cloud.sidebar.teamSessions")} · @${row.ownerDisplayName}`}
          >
            <span className="text-text-3">
              {t("navigation:cloud.sidebar.teamSessions")}
            </span>
            <span className="mx-1 text-text-4">·</span>
            <span>@{row.ownerDisplayName}</span>
          </div>
        </HoverCardRow>
        {display.externalSource && (
          <HoverCardRow icon={<Pin size={13} strokeWidth={1.75} />}>
            <div className="truncate text-text-2">
              <span className="text-text-3">
                {t("sessions:history.detail.externalSession", {
                  defaultValue: "External session",
                })}
              </span>
              <span className="mx-1 text-text-4">·</span>
              <span>{display.externalSource.displayName}</span>
            </div>
          </HoverCardRow>
        )}
        {(display.agentType ||
          row.agentDisplayName ||
          display.modelName ||
          display.externalSource) && (
          <HoverCardRow icon={renderAgentIcon(display)}>
            <div className="flex min-w-0 items-center truncate text-text-2">
              <span className="truncate">{display.agentLabel}</span>
              {display.modelName && (
                <>
                  <span className="mx-1 text-text-4">·</span>
                  <span className="mr-1 flex shrink-0 items-center">
                    <ModelIcon modelName={display.modelName} size={13} />
                  </span>
                  <span className="truncate">{display.modelName}</span>
                </>
              )}
            </div>
          </HoverCardRow>
        )}
        {row.forkedFrom?.ownerDisplayName && (
          <HoverCardRow icon={<GitFork size={13} strokeWidth={1.75} />}>
            <div className="truncate text-text-2">
              {t("navigation:cloud.sidebar.forkedFrom", {
                name: row.forkedFrom.ownerDisplayName,
                defaultValue: "forked from @{{name}}",
              })}
            </div>
          </HoverCardRow>
        )}
        {viewerNames && (
          <HoverCardRow icon={<Eye size={13} strokeWidth={1.75} />}>
            <div
              data-testid="cloud-session-watchers"
              className="truncate text-text-2"
              title={viewerNames}
            >
              {viewerNames}
            </div>
          </HoverCardRow>
        )}
        {(repoName || branchLabel) && (
          <HoverCardRow icon={<GitBranch size={13} strokeWidth={1.75} />}>
            <div className="truncate text-text-2">
              {repoName && <span>{repoName}</span>}
              {repoName && branchLabel && (
                <span className="mx-1 text-text-4">·</span>
              )}
              {branchLabel && <span>{branchLabel}</span>}
            </div>
          </HoverCardRow>
        )}
        {unresolvedComments > 0 && (
          <HoverCardRow icon={<MessageSquare size={13} strokeWidth={1.75} />}>
            <div className="truncate text-text-2">
              {t("navigation:cloud.comments.unresolvedBadge", {
                count: unresolvedComments,
              })}
            </div>
          </HoverCardRow>
        )}
        {lastActivityLabel && (
          <HoverCardRow icon={<Clock size={13} strokeWidth={1.75} />}>
            <div className="truncate text-text-2" title={lastActivityLabel}>
              <span className="text-text-3">
                {t("sessions:history.detail.lastUpdated")}
              </span>
              <span className="mx-1 text-text-4">·</span>
              <span>{lastActivityLabel}</span>
            </div>
          </HoverCardRow>
        )}
      </HoverCardPanel>
    );
  });

CloudSessionHoverCardContent.displayName = "CloudSessionHoverCardContent";

interface CloudSessionHoverCardProps {
  row?: RemoteTeammateSessionMetadata;
  viewers?: readonly { displayName: string }[];
  children: React.ReactElement;
  position?: HoverCardPosition;
  mouseEnterDelay?: number;
  mouseLeaveDelay?: number;
}

const CloudSessionHoverCard: React.FC<CloudSessionHoverCardProps> = ({
  row,
  viewers,
  children,
  position,
  mouseEnterDelay,
  mouseLeaveDelay,
}) => {
  const renderContent = useCallback(
    () =>
      row ? <CloudSessionHoverCardContent row={row} viewers={viewers} /> : null,
    [row, viewers]
  );

  return (
    <HoverCardBase
      cardId={row ? `cloud-${row.orgId}|${row.id}` : null}
      position={position}
      mouseEnterDelay={mouseEnterDelay}
      mouseLeaveDelay={mouseLeaveDelay}
      renderContent={renderContent}
    >
      {children}
    </HoverCardBase>
  );
};

export default CloudSessionHoverCard;
