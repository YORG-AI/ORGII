/**
 * PrCommitsTab
 *
 * The PR's commits, rendered with the shared `GitCommitRow` (same 36px
 * summary / author / relative-time format as the commit-history sidebar).
 * Selecting a commit opens its diff inline via `GitCommitDetailContent`,
 * which automatically fetches the PR ref when the commit is not local yet.
 */
import { ChevronLeft } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { GitCommitPerson } from "@src/api/http/git/types";
import Button from "@src/components/Button";
import GitCommitDetailContent from "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/GitCommitDetailContent";
import GitCommitRow from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/GitHistoryContent/GitCommitRow";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

interface PrCommitRow {
  sha: string;
  short_sha: string;
  summary: string;
  message: string;
  author: GitCommitPerson;
}

function mapPrCommit(raw: Record<string, unknown>): PrCommitRow | null {
  const sha = typeof raw.sha === "string" ? raw.sha : "";
  if (!sha) return null;
  const commit = (raw.commit as Record<string, unknown> | undefined) ?? {};
  const message = typeof commit.message === "string" ? commit.message : "";
  const authorRaw =
    (commit.author as Record<string, unknown> | undefined) ?? {};
  return {
    sha,
    short_sha: sha.slice(0, 7),
    summary: message.split("\n")[0] || sha.slice(0, 7),
    message,
    author: {
      name: typeof authorRaw.name === "string" ? authorRaw.name : "Unknown",
      email: typeof authorRaw.email === "string" ? authorRaw.email : "",
      date: typeof authorRaw.date === "string" ? authorRaw.date : "",
    },
  };
}

interface PrCommitsTabProps {
  commits: Record<string, unknown>[];
  prNumber: number;
  repoPath: string;
  repoId?: string;
  loading: boolean;
  onFileSelect?: (path: string) => void;
}

export const PrCommitsTab: React.FC<PrCommitsTabProps> = ({
  commits,
  prNumber,
  repoPath,
  repoId,
  loading,
  onFileSelect,
}) => {
  const { t } = useTranslation("common");
  const [selected, setSelected] = useState<PrCommitRow | null>(null);

  const rows = useMemo(
    () => commits.map(mapPrCommit).filter((c): c is PrCommitRow => c !== null),
    [commits]
  );

  const handleSelect = useCallback((commit: PrCommitRow) => {
    setSelected(commit);
  }, []);

  if (selected) {
    const resolvedRepoId = repoId ?? repoPath;
    return (
      <div className="flex h-full min-h-0 flex-col overflow-hidden">
        <div className="flex shrink-0 items-center gap-2 border-b border-border-1 px-3 py-2">
          <Button
            htmlType="button"
            variant="tertiary"
            appearance="ghost"
            size="mini"
            icon={<ChevronLeft size={14} strokeWidth={2} />}
            onClick={() => setSelected(null)}
          >
            {t("git.pr.commits.backToList", "All commits")}
          </Button>
          <span
            className="min-w-0 flex-1 truncate text-[12px] text-text-2"
            title={selected.summary}
          >
            {selected.summary}
          </span>
        </div>
        <div className="min-h-0 flex-1">
          <GitCommitDetailContent
            commitSha={selected.sha}
            shortSha={selected.short_sha}
            commitMessage={selected.message}
            repoPath={repoPath}
            repoId={resolvedRepoId}
            isRepoReady={Boolean(repoPath && resolvedRepoId)}
            onFileSelect={onFileSelect}
            publishHeaderToWorkstation={false}
            prNumber={prNumber}
          />
        </div>
      </div>
    );
  }

  if (loading && rows.length === 0) {
    return (
      <Placeholder variant="loading" placement="sidebar" fillParentHeight />
    );
  }

  if (rows.length === 0) {
    return (
      <Placeholder
        variant="empty"
        placement="sidebar"
        title={t("git.pr.commits.none", "No commits")}
        fillParentHeight
      />
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-hide">
      <div className="mx-auto w-full max-w-[920px] py-1">
        {rows.map((commit) => (
          <GitCommitRow
            key={commit.sha}
            commit={commit}
            isSelected={false}
            onSelect={handleSelect}
          />
        ))}
      </div>
    </div>
  );
};

PrCommitsTab.displayName = "PrCommitsTab";
