import {
  Bot,
  Clock,
  GitBranch,
  GitFork,
  MessageSquare,
  Pin,
  Users,
} from "lucide-react";
import React, { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";

import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory";
import { formatAgentType } from "@src/assets/providers";
import ModelIcon from "@src/components/ModelIcon";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import {
  formatReplayDateLabel,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";
import { formatBranchLabel } from "@src/util/git/branchLabel";
import { basename } from "@src/util/path";

import HoverCardBase, {
  HoverCardPanel,
  type HoverCardPosition,
  HoverCardRow,
} from "./HoverCardBase";

/**
 * Hover metadata card for "Team sessions" rows (cloudremote-* sidebar ids).
 * Local sessions render SessionHoverCard from the session store; teammate
 * rows only carry the pushed RemoteTeammateSessionMetadata, so this card
 * renders from that payload directly — no store lookup, no fetches.
 */
interface CloudSessionHoverCardContentProps {
  row: RemoteTeammateSessionMetadata;
}

export const CloudSessionHoverCardContent: React.FC<CloudSessionHoverCardContentProps> =
  memo(({ row }) => {
    const { t, i18n } = useTranslation(["navigation", "sessions", "common"]);
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
    const openTasks = row.openAgentTaskCount ?? 0;
    const activeTasks = row.activeAgentTaskCount ?? 0;
    const externalSourceId =
      row.origin?.kind === "external_history" ? row.origin.source : undefined;
    const externalSource = IMPORTED_HISTORY_SOURCE_DESCRIPTORS.find(
      (source) => source.sourceId === externalSourceId
    );

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
        {externalSource && (
          <HoverCardRow icon={<Pin size={13} strokeWidth={1.75} />}>
            <div className="truncate text-text-2">
              <span className="text-text-3">
                {t("sessions:history.detail.externalSession", {
                  defaultValue: "External session",
                })}
              </span>
              <span className="mx-1 text-text-4">·</span>
              <span>{externalSource.displayName}</span>
            </div>
          </HoverCardRow>
        )}
        {(row.cliAgentType || row.agentDisplayName || row.model) && (
          <HoverCardRow
            icon={
              row.cliAgentType ? (
                <ModelIcon agentType={row.cliAgentType} size={13} />
              ) : (
                <Bot size={13} strokeWidth={1.75} />
              )
            }
          >
            <div className="flex min-w-0 items-center truncate text-text-2">
              <span className="truncate">
                {row.cliAgentType
                  ? formatAgentType(row.cliAgentType)
                  : row.agentDisplayName || "Agent"}
              </span>
              {row.model && (
                <>
                  <span className="mx-1 text-text-4">·</span>
                  <span className="mr-1 flex shrink-0 items-center">
                    <ModelIcon modelName={row.model} size={13} />
                  </span>
                  <span className="truncate">{row.model}</span>
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
        {(openTasks > 0 || activeTasks > 0) && (
          <HoverCardRow icon={<Bot size={13} strokeWidth={1.75} />}>
            <div className="truncate text-text-2">
              {openTasks > 0 &&
                t("navigation:cloud.comments.task.openBadge", {
                  count: openTasks,
                  defaultValue_one: "{{count}} agent task awaiting pickup",
                  defaultValue_other: "{{count}} agent tasks awaiting pickup",
                })}
              {openTasks > 0 && activeTasks > 0 && (
                <span className="mx-1 text-text-4">·</span>
              )}
              {activeTasks > 0 &&
                t("navigation:cloud.comments.task.activeBadge", {
                  count: activeTasks,
                  defaultValue_one: "an agent is working on this session",
                  defaultValue_other:
                    "{{count}} agents are working on this session",
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
  children: React.ReactElement;
  position?: HoverCardPosition;
  mouseEnterDelay?: number;
  mouseLeaveDelay?: number;
}

const CloudSessionHoverCard: React.FC<CloudSessionHoverCardProps> = ({
  row,
  children,
  position,
  mouseEnterDelay,
  mouseLeaveDelay,
}) => {
  const renderContent = useCallback(
    () => (row ? <CloudSessionHoverCardContent row={row} /> : null),
    [row]
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
