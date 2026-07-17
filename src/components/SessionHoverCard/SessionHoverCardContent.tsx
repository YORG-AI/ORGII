import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAtomValue } from "jotai";
import {
  Clock,
  Diff,
  Folder,
  GitBranch,
  GitCommitVertical,
  Grip,
  Save,
  Timer,
} from "lucide-react";
import React, { memo, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type CoreSessionSummary,
  getOrgtrackSessionSummary,
} from "@src/api/tauri/lineage";
import { isHostedKey } from "@src/api/tauri/session";
import { CLI_AGENT, type CliAgentType } from "@src/api/types/keys";
import { formatAgentType } from "@src/assets/providers";
import ModelIcon from "@src/components/ModelIcon";
import { resolveAgentIcon } from "@src/config/agentIcons";
import TaskImpactLine from "@src/features/KanbanBoard/components/TaskImpactLine";
import type { KanbanTask } from "@src/features/KanbanBoard/types";
import { createLogger } from "@src/hooks/logger";
import { useResolvedModelLabel } from "@src/hooks/models";
import { useValidatedLastPair } from "@src/hooks/models/useValidatedLastPair";
import { workspaceGitStatusMapAtom } from "@src/store/git/gitStatusAtom";
import type { LastModelSelection } from "@src/store/session/creatorDefaultModelAtom";
import { sessionByIdAtom } from "@src/store/session/sessionAtom/atoms";
import {
  formatReplayDateLabel,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";
import { formatBranchLabel } from "@src/util/git/branchLabel";
import { basename } from "@src/util/path";
import {
  getDispatchCategory,
  resolveSessionIconId,
} from "@src/util/session/sessionDispatch";
import { formatDuration } from "@src/util/time/formatDuration";

import { HoverCardPanel, HoverCardRow } from "./HoverCardBase";
import {
  type SessionTurnOverview,
  useSessionTurnOverview,
} from "./useSessionTurnOverview";

const logger = createLogger("SessionHoverCard");

interface AgentSessionInfo {
  icon: React.ReactNode;
  label: string;
  textClassName?: string;
}

interface SessionHoverCardContentProps {
  sessionId: string;
}

const PATH_ROW_CLASS_NAME =
  "block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-left text-text-2 underline-offset-2 transition-colors hover:text-accent-9 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-8";
const COMPACT_PATH_MAX_CHARS = 44;

function formatCompactPath(path: string): string {
  const compactPath = path.replace(/^\/Users\/[^/]+/u, "~");
  if (compactPath.length <= COMPACT_PATH_MAX_CHARS) return compactPath;

  const parts = compactPath.split("/").filter(Boolean);
  if (parts.length <= 3) return compactPath;

  const prefix = compactPath.startsWith("~/") ? "~/" : "/";
  const start = compactPath.startsWith("~/")
    ? parts[0]
    : parts.slice(0, 2).join("/");
  const endParts = parts.slice(-2);
  const end = endParts.join("/");
  const candidate = `${prefix}${start === "~" ? "" : `${start}/`}.../${end}`;

  if (candidate.length <= COMPACT_PATH_MAX_CHARS) return candidate;
  return `${prefix}.../${parts.at(-1) ?? compactPath}`;
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/u, "");
}

function handleRevealPath(path: string): void {
  void revealItemInDir(path).catch((error: unknown) => {
    logger.warn("failed to reveal session path", { error, path });
  });
}

function getAgentSessionInfo(session: {
  session_id: string;
  cliAgentType?: CliAgentType | null;
  agentDisplayName?: string;
  agentIconId?: string;
}): AgentSessionInfo {
  const category = getDispatchCategory(session.session_id);

  if (session.cliAgentType) {
    return {
      icon: <ModelIcon agentType={session.cliAgentType} size={13} />,
      label: formatAgentType(session.cliAgentType),
    };
  }

  if (category === "cursor_ide") {
    return {
      icon: <ModelIcon agentType={CLI_AGENT.CURSOR} size={13} />,
      label: session.agentDisplayName || "Cursor IDE",
    };
  }

  const iconId =
    session.agentIconId || resolveSessionIconId(session.session_id);
  const AgentIcon = resolveAgentIcon(iconId);

  return {
    icon: <AgentIcon size={13} strokeWidth={1.75} />,
    label: session.agentDisplayName || "Agent",
    textClassName: "text-text-1",
  };
}

export const SessionHoverCardContent: React.FC<SessionHoverCardContentProps> =
  memo(({ sessionId }) => {
    const { t, i18n } = useTranslation(["sessions", "common"]);
    const session = useAtomValue(sessionByIdAtom(sessionId));
    const workspaceGitStatusMap = useAtomValue(workspaceGitStatusMapAtom);
    const creatorDefaultLastModel = useValidatedLastPair();
    const turnOverview: SessionTurnOverview | null =
      useSessionTurnOverview(sessionId);
    const repoPath = session?.repoPath;
    const storagePath = session?.storagePath;
    const [orgtrackSummary, setOrgtrackSummary] =
      useState<CoreSessionSummary | null>(null);

    useEffect(() => {
      let cancelled = false;

      getOrgtrackSessionSummary(sessionId)
        .then((summary) => {
          if (!cancelled) setOrgtrackSummary(summary);
        })
        .catch((error: unknown) => {
          logger.warn("failed to load orgtrack session summary", {
            error,
            sessionId,
          });
          if (!cancelled) setOrgtrackSummary(null);
        });

      return () => {
        cancelled = true;
      };
    }, [sessionId]);

    const lastModel: LastModelSelection | null = useMemo(() => {
      if (!session) return creatorDefaultLastModel;
      const keySource = session.keySource ?? creatorDefaultLastModel?.keySource;
      const hosted = isHostedKey(keySource);
      return {
        ...creatorDefaultLastModel,
        keySource,
        cliAgentType:
          session.cliAgentType ?? creatorDefaultLastModel?.cliAgentType,
        tier: session.tier ?? creatorDefaultLastModel?.tier,
        model: hosted
          ? undefined
          : (session.model ?? creatorDefaultLastModel?.model),
        listingModel: hosted
          ? (session.model ?? creatorDefaultLastModel?.listingModel)
          : undefined,
        selectedAccountId:
          session.accountId ?? creatorDefaultLastModel?.selectedAccountId,
      };
    }, [session, creatorDefaultLastModel]);

    const { label: modelLabel, title: modelTitle } = useResolvedModelLabel(
      lastModel,
      []
    );

    const impactTask = useMemo<KanbanTask | null>(() => {
      if (!session) return null;
      const sourceFilesChanged =
        session.filesChanged && session.filesChanged > 0
          ? session.filesChanged
          : (session.touchedFiles?.length ?? 0);
      const sourceLinesAdded = session.linesAdded ?? 0;
      const sourceLinesRemoved = session.linesRemoved ?? 0;
      const hasSummaryImpact = Boolean(
        orgtrackSummary &&
        (orgtrackSummary.filesChanged > 0 ||
          orgtrackSummary.linesAdded > 0 ||
          orgtrackSummary.linesRemoved > 0 ||
          orgtrackSummary.relatedCommits > 0)
      );
      const filesChanged = hasSummaryImpact
        ? (orgtrackSummary?.filesChanged ?? 0)
        : sourceFilesChanged;
      const linesAdded = hasSummaryImpact
        ? (orgtrackSummary?.linesAdded ?? 0)
        : sourceLinesAdded;
      const linesRemoved = hasSummaryImpact
        ? (orgtrackSummary?.linesRemoved ?? 0)
        : sourceLinesRemoved;
      const relatedCommits = hasSummaryImpact
        ? (orgtrackSummary?.relatedCommits ?? 0)
        : 0;
      const committedRatePercent = hasSummaryImpact
        ? (orgtrackSummary?.committedRatePercent ?? 0)
        : 0;
      if (
        filesChanged === 0 &&
        linesAdded === 0 &&
        linesRemoved === 0 &&
        relatedCommits === 0
      ) {
        return null;
      }

      return {
        id: session.session_id,
        title: session.name || session.session_id,
        status: "in_progress",
        impact: {
          filesChanged,
          linesAdded,
          linesRemoved,
          relatedCommits,
          committedFiles: Math.round(
            (filesChanged * committedRatePercent) / 100
          ),
          committedRatePercent,
          touchedFiles: session.touchedFiles,
        },
      };
    }, [orgtrackSummary, session]);

    if (!session) return null;

    const repoName = session.repo_name || (repoPath ? basename(repoPath) : "");
    const worktreePath = session.worktreePath;
    const normalizedRepoPath = repoPath ? normalizePath(repoPath) : undefined;
    const workspaceGitStatus = normalizedRepoPath
      ? workspaceGitStatusMap.get(normalizedRepoPath)
      : undefined;
    const worktreePathLabel = worktreePath ? basename(worktreePath) : "";
    const effectiveBranch = session.branch;
    const branchLabel =
      formatBranchLabel(session.worktreeBranch) ||
      (worktreePath ? worktreePathLabel : "") ||
      formatBranchLabel(effectiveBranch) ||
      formatBranchLabel(session.baseBranch) ||
      formatBranchLabel(workspaceGitStatus?.current_branch);
    const modelIconName =
      lastModel?.listingModel || lastModel?.model || undefined;
    const modelIconAgent = lastModel?.listingModelType || undefined;
    const agentSessionInfo = getAgentSessionInfo(session);

    const dateTimeLabelOptions = {
      todayLabel: t("common:relativeDate.today"),
      yesterdayLabel: t("common:relativeDate.yesterday"),
      locale: toIntlLocaleTag(i18n.language),
      monthStyle: "short" as const,
      withSeconds: false,
    };
    const createdLabel = formatReplayDateLabel(
      session.created_at || session.created_time,
      dateTimeLabelOptions
    );
    const updatedLabel = formatReplayDateLabel(
      session.updated_at || session.updated_time,
      dateTimeLabelOptions
    );
    const workedDurationLabel = turnOverview?.workedDurationMs
      ? formatDuration(turnOverview.workedDurationMs)
      : null;

    return (
      <HoverCardPanel title={session.name || session.session_id}>
        <HoverCardRow
          icon={agentSessionInfo.icon}
          iconClassName={agentSessionInfo.textClassName}
        >
          <div
            className={`flex min-w-0 items-center truncate ${agentSessionInfo.textClassName ?? "text-text-2"}`}
            title={
              modelTitle
                ? `${agentSessionInfo.label} · ${modelTitle}`
                : undefined
            }
          >
            <span className="truncate">{agentSessionInfo.label}</span>
            {modelLabel && (
              <>
                <span className="mx-1 text-text-4">·</span>
                <span className="mr-1 flex shrink-0 items-center">
                  {modelIconName ? (
                    <ModelIcon
                      modelName={modelIconName}
                      agentType={modelIconAgent}
                      size={13}
                    />
                  ) : (
                    <Grip size={13} strokeWidth={1.75} />
                  )}
                </span>
                <span className="truncate">{modelLabel}</span>
              </>
            )}
          </div>
        </HoverCardRow>
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
        {repoPath && (
          <HoverCardRow icon={<Folder size={13} strokeWidth={1.75} />}>
            <button
              type="button"
              className={PATH_ROW_CLASS_NAME}
              title={repoPath}
              onClick={() => handleRevealPath(repoPath)}
            >
              {formatCompactPath(repoPath)}
            </button>
          </HoverCardRow>
        )}
        {storagePath && (
          <HoverCardRow icon={<Save size={13} strokeWidth={1.75} />}>
            <button
              type="button"
              className={PATH_ROW_CLASS_NAME}
              title={storagePath}
              onClick={() => handleRevealPath(storagePath)}
            >
              {formatCompactPath(storagePath)}
            </button>
          </HoverCardRow>
        )}
        {impactTask && (
          <HoverCardRow icon={<Diff size={13} strokeWidth={1.75} />}>
            <TaskImpactLine task={impactTask} showUnavailable={false} />
          </HoverCardRow>
        )}
        {(workedDurationLabel ||
          (turnOverview && turnOverview.turnCount > 0)) && (
          <HoverCardRow icon={<Timer size={13} strokeWidth={1.75} />}>
            <div
              className="truncate text-text-2"
              title={workedDurationLabel ?? undefined}
            >
              <span className="text-text-3">
                {workedDurationLabel
                  ? t("history.detail.agentWorked")
                  : t("history.detail.rounds")}
              </span>
              {workedDurationLabel && (
                <>
                  <span className="mx-1 text-text-4">·</span>
                  <span>{workedDurationLabel}</span>
                </>
              )}
              {turnOverview && turnOverview.turnCount > 0 && (
                <>
                  <span className="mx-1 text-text-4">·</span>
                  <span>
                    {t("history.detail.roundCount", {
                      count: turnOverview.turnCount,
                    })}
                  </span>
                </>
              )}
            </div>
          </HoverCardRow>
        )}
        <HoverCardRow icon={<Clock size={13} strokeWidth={1.75} />}>
          <div className="truncate text-text-2" title={createdLabel}>
            <span className="text-text-3">{t("history.detail.created")}</span>
            <span className="mx-1 text-text-4">·</span>
            <span>{createdLabel}</span>
          </div>
        </HoverCardRow>
        <HoverCardRow icon={<GitCommitVertical size={13} strokeWidth={1.75} />}>
          <div className="truncate text-text-2" title={updatedLabel}>
            <span className="text-text-3">
              {t("history.detail.lastUpdated")}
            </span>
            <span className="mx-1 text-text-4">·</span>
            <span>{updatedLabel}</span>
          </div>
        </HoverCardRow>
      </HoverCardPanel>
    );
  });

SessionHoverCardContent.displayName = "SessionHoverCardContent";
