import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import ModelIcon from "@src/components/ModelIcon";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { createLogger } from "@src/hooks/logger";
import {
  Clock01Icon,
  FingerPrintIcon,
  GitForkIcon,
  HugeiconsIcon,
  Message01Icon,
  PinIcon,
  Tick01Icon,
  UserMultipleIcon,
  ViewIcon,
  WorkflowCircle05Icon,
} from "@src/icons";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { copyText } from "@src/util/data/clipboard";
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

const logger = createLogger("CloudSessionHoverCard");
const COPIED_FLASH_MS = 1500;
const COMPACT_ID_EDGE_CHARS = 8;
const SESSION_ID_BUTTON_CLASS_NAME =
  "block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-left text-text-2 underline-offset-2 transition-colors hover:text-accent-9 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-8";

function formatCompactSessionId(id: string): string {
  if (id.length <= COMPACT_ID_EDGE_CHARS * 2 + 2) return id;
  return `${id.slice(0, COMPACT_ID_EDGE_CHARS)}…${id.slice(-COMPACT_ID_EDGE_CHARS)}`;
}

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
  const agentIcon = resolveAgentIcon(display.agentIconId);
  return <AnyIcon icon={agentIcon} size={13} strokeWidth={1.75} />;
}

export const CloudSessionHoverCardContent: React.FC<CloudSessionHoverCardContentProps> =
  memo(({ row, viewers = [] }) => {
    const { t, i18n } = useTranslation(["navigation", "sessions", "common"]);
    const [copiedSessionId, setCopiedSessionId] = useState<string | null>(null);
    const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const display = resolveSessionDisplayMetadata({
      kind: "remote",
      session: row,
    });
    const repoName = row.repoScopeKey
      ? basename(row.repoScopeKey)
      : row.repoPath
        ? basename(row.repoPath)
        : "";
    const branchLabel =
      formatBranchLabel(row.branch) || formatBranchLabel(row.baseBranch);
    const worktreeBranchLabel = formatBranchLabel(row.worktreeBranch);
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
    const isExternal =
      row.origin?.kind === "external_history" ||
      display.externalSource !== undefined;
    const viewerNames = viewers
      .map((viewer) => viewer.displayName)
      .filter(Boolean)
      .join(", ");

    useEffect(
      () => () => {
        if (copiedTimerRef.current !== null) {
          clearTimeout(copiedTimerRef.current);
        }
      },
      []
    );

    const handleCopySessionId = useCallback(() => {
      void copyText(row.sourceSessionId)
        .then(() => {
          setCopiedSessionId(row.sourceSessionId);
          if (copiedTimerRef.current !== null) {
            clearTimeout(copiedTimerRef.current);
          }
          copiedTimerRef.current = setTimeout(() => {
            copiedTimerRef.current = null;
            setCopiedSessionId(null);
          }, COPIED_FLASH_MS);
        })
        .catch((error: unknown) => {
          logger.warn("failed to copy shared session id", {
            error,
            sessionId: row.sourceSessionId,
          });
        });
    }, [row.sourceSessionId]);

    return (
      // Fork provenance renders as the lineage row below — drop the fork
      // glyph(s) baked into pushed titles rather than doubling them here.
      <HoverCardPanel title={row.title.replace(/^(?:⑂\s*)+/u, "")}>
        <HoverCardRow
          icon={
            <HugeiconsIcon
              icon={UserMultipleIcon}
              data-icon="users"
              size={13}
              strokeWidth={1.75}
            />
          }
        >
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
        <HoverCardRow
          icon={
            <HugeiconsIcon
              icon={PinIcon}
              data-icon="pin"
              size={13}
              strokeWidth={1.75}
            />
          }
        >
          <div className="truncate text-text-2">
            <span className="text-text-3">
              {isExternal
                ? t("sessions:history.detail.external")
                : t("sessions:history.detail.internal")}
            </span>
            {display.externalSource && (
              <>
                <span className="mx-1 text-text-4">·</span>
                <span>{display.externalSource.displayName}</span>
              </>
            )}
          </div>
        </HoverCardRow>
        {(display.agentType ||
          row.agentDisplayName ||
          display.modelName ||
          display.externalSource) && (
          <HoverCardRow
            icon={renderAgentIcon(display)}
            iconClassName="text-text-1"
          >
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
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={GitForkIcon}
                data-icon="git-fork"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            <div className="truncate text-text-2">
              {t("navigation:cloud.sidebar.forkedFrom", {
                name: row.forkedFrom.ownerDisplayName,
                defaultValue: "forked from @{{name}}",
              })}
            </div>
          </HoverCardRow>
        )}
        {viewerNames && (
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={ViewIcon}
                data-icon="eye"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
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
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={WorkflowCircle05Icon}
                data-icon="git-branch"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            <div
              className="flex min-w-0 items-center text-text-2"
              data-testid="session-hover-repo-branch"
              title={[repoName, branchLabel].filter(Boolean).join(" · ")}
            >
              {repoName && (
                <span
                  className={
                    branchLabel
                      ? "min-w-0 max-w-[calc(50%-6px)] truncate"
                      : "min-w-0 flex-1 truncate"
                  }
                  data-testid="session-hover-workspace"
                  title={row.repoScopeKey ?? row.repoPath}
                >
                  {repoName}
                </span>
              )}
              {repoName && branchLabel && (
                <span className="mx-1 shrink-0 text-text-4">·</span>
              )}
              {branchLabel && (
                <span
                  className={
                    repoName
                      ? "min-w-0 max-w-[calc(50%-6px)] truncate"
                      : "min-w-0 flex-1 truncate"
                  }
                  data-testid="session-hover-branch"
                  title={branchLabel}
                >
                  {branchLabel}
                </span>
              )}
            </div>
          </HoverCardRow>
        )}
        {worktreeBranchLabel && worktreeBranchLabel !== branchLabel && (
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={GitForkIcon}
                data-icon="git-fork"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            <div
              className="truncate text-text-2"
              data-testid="session-hover-worktree-branch"
              title={worktreeBranchLabel}
            >
              {worktreeBranchLabel}
            </div>
          </HoverCardRow>
        )}
        <HoverCardRow
          icon={
            <HugeiconsIcon
              icon={FingerPrintIcon}
              data-icon="fingerprint"
              size={13}
              strokeWidth={1.75}
            />
          }
        >
          <button
            type="button"
            className={SESSION_ID_BUTTON_CLASS_NAME}
            title={row.sourceSessionId}
            aria-label={`${t("common:actions.copy")} ${t(
              "sessions:history.detail.sessionId"
            )}`}
            onClick={handleCopySessionId}
          >
            <span className="text-text-3">
              {t("sessions:history.detail.sessionId")}
            </span>
            <span className="mx-1 text-text-4">·</span>
            <span>{formatCompactSessionId(row.sourceSessionId)}</span>
            {copiedSessionId === row.sourceSessionId && (
              <HugeiconsIcon
                icon={Tick01Icon}
                data-icon="check"
                size={12}
                strokeWidth={2}
                className="ml-1 inline-block align-[-1px] text-success-6"
                aria-hidden="true"
              />
            )}
          </button>
        </HoverCardRow>
        {unresolvedComments > 0 && (
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={Message01Icon}
                data-icon="message-square"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
            <div className="truncate text-text-2">
              {t("navigation:cloud.comments.unresolvedBadge", {
                count: unresolvedComments,
              })}
            </div>
          </HoverCardRow>
        )}
        {lastActivityLabel && (
          <HoverCardRow
            icon={
              <HugeiconsIcon
                icon={Clock01Icon}
                data-icon="clock"
                size={13}
                strokeWidth={1.75}
              />
            }
          >
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
