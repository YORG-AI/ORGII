/**
 * AIImpactContent — Standalone AI Session Impact dashboard.
 *
 * Full-page scrollable view showing how AI coding sessions influenced the
 * codebase: files touched, functions created, commits influenced, lines
 * attributed. Self-contained — queries provenance data directly from SQLite.
 *
 * Ratio bars compare AI-attributed metrics against total git activity.
 */
import { useAtomValue } from "jotai";
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { getGitCommitDiff, getGitCommits } from "@src/api/http/git";
import {
  type SessionImpact,
  getProvenanceSessionIds,
  getSessionImpact,
} from "@src/api/tauri/lineage";
import { Placeholder } from "@src/components/Placeholder";
import {
  FileCodeIcon,
  FunctionSquareIcon,
  GitCommitHorizontalIcon,
  HashtagIcon,
  HugeiconsIcon,
  SparklesIcon,
} from "@src/icons";
import {
  CollapsibleSection,
  DETAIL_PANEL_TOKENS,
  PanelHeader,
  PanelRefreshButton,
} from "@src/modules/shared/layouts/blocks";
import { activeWorkspaceRootAtom } from "@src/store/workspace";

const MAX_SESSIONS_TO_QUERY = 20;
const MAX_RECENT_COMMITS = 200;
const DIFF_CONCURRENCY = 5;

// ============================================
// Types
// ============================================

interface AggregatedImpact {
  sessionsWithImpact: number;
  totalFilesTouched: number;
  totalFunctionsCreated: number;
  totalCommitsInfluenced: number;
  totalLinesAttributed: number;
  sessions: Array<{
    sessionId: string;
    impact: SessionImpact;
  }>;
}

interface GitBaseline {
  totalCommits: number;
  totalInsertions: number;
  totalFiles: number;
}

// ============================================
// Aggregation
// ============================================

function aggregateImpacts(impacts: SessionImpact[]): AggregatedImpact {
  const allFiles = new Set<string>();
  const allCommits = new Set<string>();
  let totalFunctions = 0;
  let totalLines = 0;
  const sessions: AggregatedImpact["sessions"] = [];

  for (const impact of impacts) {
    const hasData =
      impact.filesTouched.length > 0 ||
      impact.functionsCreated.length > 0 ||
      impact.commitsInfluenced.length > 0;
    if (!hasData) continue;

    for (const file of impact.filesTouched) allFiles.add(file);
    for (const commit of impact.commitsInfluenced) allCommits.add(commit);
    totalFunctions += impact.functionsCreated.length;
    totalLines += impact.totalLinesAttributed;
    sessions.push({ sessionId: impact.sessionId, impact });
  }

  return {
    sessionsWithImpact: sessions.length,
    totalFilesTouched: allFiles.size,
    totalFunctionsCreated: totalFunctions,
    totalCommitsInfluenced: allCommits.size,
    totalLinesAttributed: totalLines,
    sessions,
  };
}

async function fetchGitBaseline(
  repoId: string,
  repoPath: string,
  cancelled: { current: boolean }
): Promise<GitBaseline | null> {
  const response = await getGitCommits({
    repo_id: repoId,
    repo_path: repoPath,
    limit: MAX_RECENT_COMMITS,
  });
  if (cancelled.current || !response) return null;

  const commits = response.commits;
  const totalCommits = commits.length;

  const allFiles = new Set<string>();
  let totalInsertions = 0;

  for (let idx = 0; idx < commits.length; idx += DIFF_CONCURRENCY) {
    if (cancelled.current) return null;
    const batch = commits.slice(idx, idx + DIFF_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((commit) =>
        getGitCommitDiff({
          repo_id: repoId,
          repo_path: repoPath,
          commit_sha: commit.sha,
          context_lines: 0,
        })
      )
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        totalInsertions += result.value.stats.insertions;
        for (const file of result.value.files) {
          allFiles.add(file.file_path);
        }
      }
    }
  }

  return { totalCommits, totalInsertions, totalFiles: allFiles.size };
}

// ============================================
// Stat Card with Ratio Bar
// ============================================

interface StatItemProps {
  icon: React.ReactNode;
  label: string;
  value: number;
  total?: number;
  totalLabel?: string;
}

const StatItem: React.FC<StatItemProps> = memo(
  ({ icon, label, value, total, totalLabel }) => {
    const hasRatio = total !== undefined && total > 0;
    const aiPct = hasRatio ? Math.min((value / total) * 100, 100) : 0;
    const humanValue = hasRatio ? Math.max(total - value, 0) : 0;
    const humanPct = hasRatio ? 100 - aiPct : 0;

    return (
      <div className="flex flex-col gap-1.5 rounded-xl border border-border-1 bg-fill-2 p-4">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-text-3">
          {icon}
          {label}
        </div>
        <span className="text-2xl font-semibold text-text-1">
          {value.toLocaleString()}
        </span>
        {hasRatio && (
          <div className="flex flex-col gap-1.5">
            <div className="h-2 w-full overflow-hidden rounded-full bg-fill-3">
              <div
                className="h-full rounded-full bg-primary-6 transition-all duration-500"
                style={{ width: `${aiPct}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px]">
              <span className="text-primary-6">AI {Math.round(aiPct)}%</span>
              <span className="text-text-4">
                {totalLabel} {humanValue.toLocaleString()} (
                {Math.round(humanPct)}%)
              </span>
            </div>
          </div>
        )}
      </div>
    );
  }
);
StatItem.displayName = "StatItem";

// ============================================
// Session Row
// ============================================

interface SessionRowProps {
  sessionId: string;
  impact: SessionImpact;
}

const SessionRow: React.FC<SessionRowProps> = memo(({ sessionId, impact }) => (
  <div className="group flex items-center justify-between overflow-hidden rounded-lg border border-border-1 bg-fill-1 p-3 transition-colors hover:bg-fill-2">
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <HugeiconsIcon
        icon={SparklesIcon}
        data-icon="sparkles"
        size={14}
        className="flex-shrink-0 text-primary-6"
      />
      <span className="truncate text-[12px] text-text-2">
        {sessionId.slice(0, 12)}…
      </span>
    </div>
    <div className="flex items-center gap-4 text-[11px]">
      <span className="flex items-center gap-1 text-text-3">
        <HugeiconsIcon icon={FileCodeIcon} data-icon="file-code-2" size={11} />
        {impact.filesTouched.length}
      </span>
      <span className="flex items-center gap-1 text-text-3">
        <HugeiconsIcon
          icon={FunctionSquareIcon}
          data-icon="function-square"
          size={11}
        />
        {impact.functionsCreated.length}
      </span>
      <span className="flex items-center gap-1 text-text-3">
        <HugeiconsIcon
          icon={GitCommitHorizontalIcon}
          data-icon="git-commit-horizontal"
          size={11}
        />
        {impact.commitsInfluenced.length}
      </span>
      <span className="flex items-center gap-1 text-text-3">
        <HugeiconsIcon icon={HashtagIcon} data-icon="hash" size={11} />
        {impact.totalLinesAttributed}
      </span>
    </div>
  </div>
));
SessionRow.displayName = "SessionRow";

// ============================================
// File List (expanded view per session)
// ============================================

interface FileListProps {
  files: string[];
}

const FileList: React.FC<FileListProps> = memo(({ files }) => {
  if (files.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1.5">
      {files.map((file) => {
        const basename = file.split("/").pop() ?? file;
        return (
          <span
            key={file}
            title={file}
            className="rounded bg-fill-2 px-2 py-0.5 text-[11px] text-text-3"
          >
            {basename}
          </span>
        );
      })}
    </div>
  );
});
FileList.displayName = "FileList";

// ============================================
// Main Component
// ============================================

const AIImpactContent: React.FC = () => {
  const { t } = useTranslation();
  const activeWorkspaceRoot = useAtomValue(activeWorkspaceRootAtom);
  const [aggregated, setAggregated] = useState<AggregatedImpact | null>(null);
  const [baseline, setBaseline] = useState<GitBaseline | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const cancelRef = useRef({ current: false });

  const loadData = useCallback(async () => {
    const cancelled = cancelRef.current;
    cancelled.current = false;
    setLoading(true);

    try {
      const sessionIds = await getProvenanceSessionIds();
      if (cancelled.current) return;

      if (sessionIds.length === 0) {
        setAggregated(null);
        setBaseline(null);
        setLoading(false);
        return;
      }

      const idsToQuery = sessionIds.slice(0, MAX_SESSIONS_TO_QUERY);
      const results = await Promise.allSettled(
        idsToQuery.map((sid) => getSessionImpact(sid))
      );
      if (cancelled.current) return;

      const impacts: SessionImpact[] = [];
      for (const result of results) {
        if (result.status === "fulfilled") {
          impacts.push(result.value);
        }
      }

      const agg = aggregateImpacts(impacts);
      setAggregated(agg);

      if (activeWorkspaceRoot?.path) {
        const gitData = await fetchGitBaseline(
          activeWorkspaceRoot.repoId ?? activeWorkspaceRoot.id,
          activeWorkspaceRoot.path,
          cancelled
        );
        if (!cancelled.current) setBaseline(gitData);
      }
    } catch {
      if (cancelled.current) return;
    } finally {
      if (!cancelled.current) setLoading(false);
    }
  }, [activeWorkspaceRoot]);

  useEffect(() => {
    const cancelled = { current: false };
    cancelRef.current = cancelled;

    loadData();

    return () => {
      cancelled.current = true;
    };
  }, [loadData]);

  const hasData = aggregated && aggregated.sessionsWithImpact > 0;

  const handleToggleSession = useCallback((sessionId: string) => {
    setExpandedSession((prev) => (prev === sessionId ? null : sessionId));
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <PanelHeader
        icon={SparklesIcon}
        title={t("aiImpact.title")}
        background="transparent"
        actions={
          <PanelRefreshButton
            onRefresh={loadData}
            loading={loading}
            title={t("common:actions.refresh")}
          />
        }
      />

      {loading ? (
        <Placeholder
          variant="loading"
          placement="detail-panel"
          fillParentHeight
        />
      ) : !hasData ? (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("aiImpact.noData")}
        />
      ) : (
        <div className={DETAIL_PANEL_TOKENS.scrollContent}>
          <div>
            {/* Overview Stats */}
            <div
              className={`${DETAIL_PANEL_TOKENS.sectionGap} grid grid-cols-2 gap-3 sm:grid-cols-5`}
            >
              <StatItem
                icon={
                  <HugeiconsIcon
                    icon={SparklesIcon}
                    data-icon="sparkles"
                    size={12}
                  />
                }
                label={t("aiImpact.sessions")}
                value={aggregated.sessionsWithImpact}
              />
              <StatItem
                icon={
                  <HugeiconsIcon
                    icon={FileCodeIcon}
                    data-icon="file-code-2"
                    size={12}
                  />
                }
                label={t("aiImpact.files")}
                value={aggregated.totalFilesTouched}
                total={baseline?.totalFiles}
                totalLabel={t("aiImpact.human")}
              />
              <StatItem
                icon={
                  <HugeiconsIcon
                    icon={FunctionSquareIcon}
                    data-icon="function-square"
                    size={12}
                  />
                }
                label={t("aiImpact.functions")}
                value={aggregated.totalFunctionsCreated}
              />
              <StatItem
                icon={
                  <HugeiconsIcon
                    icon={GitCommitHorizontalIcon}
                    data-icon="git-commit-horizontal"
                    size={12}
                  />
                }
                label={t("aiImpact.commits")}
                value={aggregated.totalCommitsInfluenced}
                total={baseline?.totalCommits}
                totalLabel={t("aiImpact.human")}
              />
              <StatItem
                icon={
                  <HugeiconsIcon
                    icon={HashtagIcon}
                    data-icon="hash"
                    size={12}
                  />
                }
                label={t("aiImpact.lines")}
                value={aggregated.totalLinesAttributed}
                total={baseline?.totalInsertions}
                totalLabel={t("aiImpact.human")}
              />
            </div>

            {/* Session List */}
            <CollapsibleSection title={t("aiImpact.sessionBreakdown")}>
              <div className="flex flex-col gap-1.5">
                {aggregated.sessions.map(({ sessionId, impact }) => (
                  <div key={sessionId}>
                    <button
                      type="button"
                      className="w-full text-left"
                      onClick={() => handleToggleSession(sessionId)}
                    >
                      <SessionRow sessionId={sessionId} impact={impact} />
                    </button>
                    {expandedSession === sessionId && (
                      <div className="mb-2 ml-6 mt-1">
                        <FileList files={impact.filesTouched} />
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CollapsibleSection>
          </div>
        </div>
      )}
    </div>
  );
};

export default memo(AIImpactContent);
