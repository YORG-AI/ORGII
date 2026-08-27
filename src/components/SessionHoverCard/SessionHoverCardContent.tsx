import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useAtomValue } from "jotai";
import {
  Check,
  Clock,
  Diff,
  Fingerprint,
  GitBranch,
  GitCommitVertical,
  GitFork,
  Grip,
  Save,
  Timer,
} from "lucide-react";
import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory/imported/descriptors";
import {
  type CoreSessionSummary,
  getOrgtrackSessionSummary,
} from "@src/api/tauri/lineage";
import { isHostedKey } from "@src/api/tauri/session";
import ClientOriginBadge from "@src/components/ClientOriginBadge";
import ModelIcon from "@src/components/ModelIcon";
import { resolveAgentIcon } from "@src/config/agentIcons";
import TaskImpactLine from "@src/features/KanbanBoard/components/TaskImpactLine";
import type { KanbanTask } from "@src/features/KanbanBoard/types";
import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { createLogger } from "@src/hooks/logger";
import { useResolvedModelLabel } from "@src/hooks/models";
import { useValidatedLastPair } from "@src/hooks/models/useValidatedLastPair";
import { workspaceGitStatusMapAtom } from "@src/store/git/gitStatusAtom";
import type { LastModelSelection } from "@src/store/session/creatorDefaultModelAtom";
import { sessionByIdAtom } from "@src/store/session/sessionAtom/atoms";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace/derived";
import { copyText } from "@src/util/data/clipboard";
import {
  formatReplayDateLabel,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";
import { formatBranchLabel } from "@src/util/git/branchLabel";
import { basename } from "@src/util/path";
import { getFileManagerRevealLabelKey } from "@src/util/platform/fileManagerLabels";
import {
  isCliSession,
  isHumanSession,
} from "@src/util/session/sessionDispatch";
import {
  type SessionDisplayMetadata,
  resolveSessionDisplayMetadata,
} from "@src/util/session/sessionDisplayMetadata";
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

/** Mirror of the `cli_agent_transcript_path` command payload. */
interface CliTranscriptLocation {
  /** True when the transcript of record lives in the CLI's native store. */
  native: boolean;
  /** Resolved native store path, when the imported-history cache has it. */
  path: string | null;
}

/**
 * Minimal mirror of the `cli_agent_status` command payload (`CodeSession`,
 * camelCase). Only the bound native CLI id is read here.
 */
interface CliAgentStatusPayload {
  /** The CLI's own session id (e.g. Claude jsonl stem), once bound. */
  cliSessionId?: string | null;
}

const PATH_ROW_CLASS_NAME =
  "block max-w-full overflow-hidden text-ellipsis whitespace-nowrap text-left text-text-2 underline-offset-2 transition-colors hover:text-accent-9 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-8";
/** Inline link used for text that sits beside other text inside a row. */
const INLINE_LINK_CLASS_NAME =
  "text-text-2 underline-offset-2 transition-colors hover:text-accent-9 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-8";
/** Trailing icon-only affordance that reveals a path in the file manager. */
const REVEAL_ICON_BUTTON_CLASS_NAME =
  "flex shrink-0 items-center rounded text-text-4 transition-colors hover:text-accent-9 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-8";
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

/** How long the copied-check flash stays visible on the session-id row. */
const COPIED_FLASH_MS = 1500;
/** Characters kept on each side when middle-truncating a session id. */
const COMPACT_ID_EDGE_CHARS = 8;

/**
 * Middle-truncate a session id so both the distinctive head and tail stay
 * visible (UUIDs differ at both ends; opencode `ses_` ids differ at the tail).
 */
function formatCompactSessionId(id: string): string {
  if (id.length <= COMPACT_ID_EDGE_CHARS * 2 + 2) return id;
  return `${id.slice(0, COMPACT_ID_EDGE_CHARS)}…${id.slice(-COMPACT_ID_EDGE_CHARS)}`;
}

/**
 * Strip the imported-history prefix (`claudecodeapp-`, `codexapp-`,
 * `cursoride-`, ...) and return the RAW source-store session id — the value
 * that matches the CLI's own tooling (Claude jsonl stem, Codex rollout id,
 * opencode `ses_` id, Cursor composer UUID). Returns `null` for
 * non-imported sessions.
 */
function getImportedRawSessionId(sessionId: string): string | null {
  for (const descriptor of IMPORTED_HISTORY_SOURCE_DESCRIPTORS) {
    if (sessionId.startsWith(descriptor.prefix)) {
      const raw = sessionId.slice(descriptor.prefix.length);
      return raw.length > 0 ? raw : null;
    }
  }
  return null;
}

function handleRevealPath(path: string): void {
  void revealItemInDir(path).catch((error: unknown) => {
    logger.warn("failed to reveal session path", { error, path });
  });
}

function getAgentSessionInfo(
  display: SessionDisplayMetadata
): AgentSessionInfo {
  const AgentIcon = resolveAgentIcon(display.agentIconId);

  return {
    icon: <AgentIcon size={13} strokeWidth={1.75} />,
    label: display.agentLabel,
    textClassName: "text-text-1",
  };
}

export const SessionHoverCardContent: React.FC<SessionHoverCardContentProps> =
  memo(({ sessionId }) => {
    const { t, i18n } = useTranslation(["sessions", "common"]);
    const session = useAtomValue(sessionByIdAtom(sessionId));
    const humanSession = isHumanSession(sessionId);
    const sessionDisplay = useMemo(
      () =>
        session
          ? resolveSessionDisplayMetadata({ kind: "local", session })
          : null,
      [session]
    );
    const workspaceGitStatusMap = useAtomValue(workspaceGitStatusMapAtom);
    const activeWorkspaceRootPath = useAtomValue(activeWorkspaceRootPathAtom);
    const { currentBranch: activeWorkspaceBranch } = useRepoSelection({
      autoLoad: false,
    });
    const creatorDefaultLastModel = useValidatedLastPair();
    const turnOverview: SessionTurnOverview | null =
      useSessionTurnOverview(sessionId);
    const repoPath = session?.repoPath;
    const storagePath = session?.storagePath;
    const cliAgentType = session?.cliAgentType;
    const [orgtrackSummary, setOrgtrackSummary] =
      useState<CoreSessionSummary | null>(null);
    const [transcriptLocationState, setTranscriptLocationState] = useState<{
      sessionId: string;
      location: CliTranscriptLocation;
    } | null>(null);
    const [boundCliIdState, setBoundCliIdState] = useState<{
      sessionId: string;
      cliSessionId: string | null;
    } | null>(null);
    // Keyed on session id so switching cards never shows a stale check.
    const [copiedForSessionId, setCopiedForSessionId] = useState<string | null>(
      null
    );
    const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    // Native-transcript sessions keep their transcript in the CLI's own
    // store, not sessions.db — resolve the real location for the storage row.
    useEffect(() => {
      let cancelled = false;
      if (!cliAgentType) return undefined;

      invoke<CliTranscriptLocation>("cli_agent_transcript_path", { sessionId })
        .then((location) => {
          if (!cancelled) setTranscriptLocationState({ sessionId, location });
        })
        .catch((error: unknown) => {
          logger.warn("failed to resolve session transcript path", {
            error,
            sessionId,
          });
        });

      return () => {
        cancelled = true;
      };
    }, [cliAgentType, sessionId]);

    // Managed CLI sessions (`cliagent-*`): the bound native CLI id lives on
    // the `code_sessions` row already returned by `cli_agent_status` — no
    // new backend surface needed.
    useEffect(() => {
      let cancelled = false;
      if (!isCliSession(sessionId)) return undefined;

      invoke<CliAgentStatusPayload | null>("cli_agent_status", { sessionId })
        .then((status) => {
          if (!cancelled) {
            setBoundCliIdState({
              sessionId,
              cliSessionId: status?.cliSessionId ?? null,
            });
          }
        })
        .catch((error: unknown) => {
          logger.warn("failed to load bound cli session id", {
            error,
            sessionId,
          });
        });

      return () => {
        cancelled = true;
      };
    }, [sessionId]);

    // Clear any pending copied-flash timer on unmount.
    useEffect(() => {
      return () => {
        if (copiedTimerRef.current !== null) {
          clearTimeout(copiedTimerRef.current);
          copiedTimerRef.current = null;
        }
      };
    }, []);

    const transcriptLocation =
      transcriptLocationState?.sessionId === sessionId
        ? transcriptLocationState.location
        : null;

    // The session's underlying id in its source store, for non-org2-native
    // sessions: imported external rows expose the prefix-stripped raw id;
    // managed CLI rows expose the bound native CLI id (null until the first
    // turn binds one). Pure Rust-agent sessions stay null — row hidden.
    const underlyingSessionId = useMemo(() => {
      const importedRawId = getImportedRawSessionId(sessionId);
      if (importedRawId) return importedRawId;
      if (boundCliIdState?.sessionId === sessionId) {
        return boundCliIdState.cliSessionId;
      }
      return null;
    }, [boundCliIdState, sessionId]);

    const lastModel: LastModelSelection | null = useMemo(() => {
      if (humanSession) return null;
      if (!session) return creatorDefaultLastModel;
      if (session.importedFrom) {
        return sessionDisplay?.modelName
          ? {
              model: sessionDisplay.modelName,
              cliAgentType: sessionDisplay.cliAgentType,
            }
          : null;
      }
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
    }, [creatorDefaultLastModel, humanSession, session, sessionDisplay]);

    const { label: resolvedModelLabel, title: resolvedModelTitle } =
      useResolvedModelLabel(lastModel, []);
    const modelLabel = humanSession ? null : resolvedModelLabel;
    const modelTitle = humanSession ? null : resolvedModelTitle;

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
    const resolvedSessionDisplay =
      sessionDisplay ??
      resolveSessionDisplayMetadata({ kind: "local", session });

    const handleCopyUnderlyingId = (value: string): void => {
      void copyText(value)
        .then(() => {
          setCopiedForSessionId(sessionId);
          if (copiedTimerRef.current !== null) {
            clearTimeout(copiedTimerRef.current);
          }
          copiedTimerRef.current = setTimeout(() => {
            copiedTimerRef.current = null;
            setCopiedForSessionId(null);
          }, COPIED_FLASH_MS);
        })
        .catch((error: unknown) => {
          logger.warn("failed to copy session id", { error, sessionId });
        });
    };

    const repoName = session.repo_name || (repoPath ? basename(repoPath) : "");
    const worktreePath = session.worktreePath;
    const normalizedRepoPath = repoPath ? normalizePath(repoPath) : undefined;
    const workspaceGitStatus = normalizedRepoPath
      ? workspaceGitStatusMap.get(normalizedRepoPath)
      : undefined;
    const worktreePathLabel = worktreePath ? basename(worktreePath) : "";
    const effectiveBranch = session.branch;
    const sessionRepoMatchesActive =
      !!normalizedRepoPath &&
      !!activeWorkspaceRootPath &&
      normalizedRepoPath === normalizePath(activeWorkspaceRootPath);
    const branchLabel =
      formatBranchLabel(effectiveBranch) ||
      formatBranchLabel(session.baseBranch) ||
      formatBranchLabel(workspaceGitStatus?.current_branch) ||
      (sessionRepoMatchesActive
        ? formatBranchLabel(activeWorkspaceBranch)
        : "");
    const worktreeBranchLabel =
      formatBranchLabel(session.worktreeBranch) ||
      (worktreePath ? worktreePathLabel : "");
    const modelIconName =
      lastModel?.listingModel || lastModel?.model || undefined;
    const modelIconAgent =
      lastModel?.listingModelType || resolvedSessionDisplay.cliAgentType;
    const agentSessionInfo = getAgentSessionInfo(resolvedSessionDisplay);
    // Native-transcript sessions must not claim sessions.db: show the CLI
    // store file when resolved, else a plain "CLI native store" label.
    const isNativeTranscript = transcriptLocation?.native === true;
    const storageRowPath = isNativeTranscript
      ? (transcriptLocation?.path ?? undefined)
      : storagePath;
    const revealLabel = t(getFileManagerRevealLabelKey());

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
            <ClientOriginBadge
              origin={resolvedSessionDisplay.clientOrigin}
              originRaw={session?.clientOriginRaw}
              className="ml-1 shrink-0"
            />
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
            <div
              className="flex min-w-0 items-center text-text-2"
              data-testid="session-hover-repo-branch"
              title={[repoName, branchLabel].filter(Boolean).join(" · ")}
            >
              {repoName &&
                (repoPath ? (
                  <button
                    type="button"
                    className={`${INLINE_LINK_CLASS_NAME} min-w-0 truncate text-left ${
                      branchLabel ? "max-w-[calc(50%-6px)]" : "flex-1"
                    }`}
                    data-testid="session-hover-workspace"
                    title={`${revealLabel} · ${repoPath}`}
                    aria-label={`${revealLabel} ${repoPath}`}
                    onClick={() => handleRevealPath(repoPath)}
                  >
                    {repoName}
                  </button>
                ) : (
                  <span
                    className={
                      branchLabel
                        ? "min-w-0 max-w-[calc(50%-6px)] truncate"
                        : "min-w-0 flex-1 truncate"
                    }
                    data-testid="session-hover-workspace"
                    title={repoName}
                  >
                    {repoName}
                  </span>
                ))}
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
          <HoverCardRow icon={<GitFork size={13} strokeWidth={1.75} />}>
            <div
              className="truncate text-text-2"
              data-testid="session-hover-worktree-branch"
              title={worktreeBranchLabel}
            >
              {worktreeBranchLabel}
            </div>
          </HoverCardRow>
        )}
        {(underlyingSessionId || storageRowPath || isNativeTranscript) && (
          <HoverCardRow
            icon={
              underlyingSessionId ? (
                <Fingerprint size={13} strokeWidth={1.75} />
              ) : (
                <Save size={13} strokeWidth={1.75} />
              )
            }
          >
            <div className="flex min-w-0 items-center gap-1">
              {underlyingSessionId ? (
                <button
                  type="button"
                  className={`${PATH_ROW_CLASS_NAME} min-w-0 flex-1`}
                  title={underlyingSessionId}
                  aria-label={`${t("common:actions.copy")} ${t(
                    "history.detail.sessionId"
                  )}`}
                  onClick={() => handleCopyUnderlyingId(underlyingSessionId)}
                >
                  <span className="text-text-3">
                    {t("history.detail.sessionId")}
                  </span>
                  <span className="mx-1 text-text-4">·</span>
                  <span>{formatCompactSessionId(underlyingSessionId)}</span>
                  {copiedForSessionId === sessionId && (
                    <Check
                      size={12}
                      strokeWidth={2}
                      className="ml-1 inline-block align-[-1px] text-success-6"
                      aria-hidden="true"
                    />
                  )}
                </button>
              ) : storageRowPath ? (
                <button
                  type="button"
                  className={`${PATH_ROW_CLASS_NAME} min-w-0 flex-1`}
                  title={`${revealLabel} · ${storageRowPath}`}
                  aria-label={`${revealLabel} ${storageRowPath}`}
                  onClick={() => handleRevealPath(storageRowPath)}
                >
                  {formatCompactPath(storageRowPath)}
                </button>
              ) : (
                <span className="min-w-0 flex-1 truncate text-text-2">
                  {t("history.detail.cliNativeStore")}
                </span>
              )}
              {/* Transcript file for a row already spoken for by the id. */}
              {underlyingSessionId && storageRowPath && (
                <button
                  type="button"
                  className={REVEAL_ICON_BUTTON_CLASS_NAME}
                  title={`${revealLabel} · ${storageRowPath}`}
                  aria-label={`${revealLabel} ${storageRowPath}`}
                  onClick={() => handleRevealPath(storageRowPath)}
                >
                  <Save size={12} strokeWidth={1.75} />
                </button>
              )}
            </div>
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
