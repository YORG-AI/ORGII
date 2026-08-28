/**
 * PrCommitsTab
 *
 * The PR's commits, grouped by date in GitHub-style timeline cards. Each card
 * keeps the useful commit metadata visible while matching the Conversation
 * tab's bordered primary-container surface. Selecting a commit opens its diff
 * inline via `GitCommitDetailContent`, which automatically fetches the PR ref
 * when the commit is not local yet.
 */
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { GitCommitPerson } from "@src/api/http/git/types";
import type { GitHubChecksSummary } from "@src/api/tauri/github";
import AnyIcon from "@src/components/AnyIcon";
import Avatar from "@src/components/Avatar";
import Button from "@src/components/Button";
import { Placeholder } from "@src/components/Placeholder";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { useCopyCheck } from "@src/hooks/ui";
import {
  ArrowLeft01Icon,
  CancelCircleIcon,
  CheckmarkCircle01Icon,
  CircleDotDashedIcon,
  CodeIcon,
  Copy01Icon,
  GitCommitHorizontalIcon,
  HugeiconsIcon,
  SecurityCheckIcon,
  Tick01Icon,
} from "@src/icons";
import GitCommitDetailContent from "@src/modules/WorkStation/CodeEditor/Panels/EditorMainPane/content/GitCommitDetailContent";
import { ActivityHeaderActionButton } from "@src/modules/shared/components/ActivityTimeline";
import { copyText } from "@src/util/data/clipboard";
import { formatDate } from "@src/util/data/formatters/date";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

interface PrCommitRow {
  sha: string;
  short_sha: string;
  summary: string;
  message: string;
  description: string;
  author: GitCommitPerson;
  actor: {
    login: string;
    avatarUrl: string;
  };
  verified: boolean;
}

interface PrCommitGroup {
  key: string;
  dateLabel: string;
  commits: PrCommitRow[];
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function readString(record: Record<string, unknown>, key: string): string {
  return typeof record[key] === "string" ? record[key] : "";
}

function mapPrCommit(
  raw: Record<string, unknown>,
  unknownAuthor: string
): PrCommitRow | null {
  const sha = typeof raw.sha === "string" ? raw.sha : "";
  if (!sha) return null;
  const commit = readRecord(raw.commit);
  const message = readString(commit, "message");
  const [summaryLine = "", ...descriptionLines] = message.split("\n");
  const authorRaw = readRecord(commit.author);
  const committerRaw = readRecord(commit.committer);
  const accountRaw = readRecord(raw.author);
  const committerAccountRaw = readRecord(raw.committer);
  const actorRaw = Object.keys(accountRaw).length
    ? accountRaw
    : committerAccountRaw;
  const authorName = readString(authorRaw, "name") || unknownAuthor;
  const authorDate =
    readString(committerRaw, "date") || readString(authorRaw, "date");
  const verification = readRecord(commit.verification);
  return {
    sha,
    short_sha: sha.slice(0, 7),
    summary: summaryLine || sha.slice(0, 7),
    message,
    description: descriptionLines.join("\n").trim(),
    author: {
      name: authorName,
      email: readString(authorRaw, "email"),
      date: authorDate,
    },
    actor: {
      login: readString(actorRaw, "login") || authorName,
      avatarUrl: readString(actorRaw, "avatar_url"),
    },
    verified: verification.verified === true,
  };
}

function groupCommits(
  rows: PrCommitRow[],
  unknownDate: string
): PrCommitGroup[] {
  const groups: PrCommitGroup[] = [];
  for (const commit of rows) {
    const dateLabel = commit.author.date
      ? formatDate(commit.author.date, {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: undefined,
          minute: undefined,
        })
      : unknownDate;
    const key = commit.author.date ? dateLabel : "unknown";
    const previous = groups.at(-1);
    if (previous?.key === key) {
      previous.commits.push(commit);
    } else {
      groups.push({ key, dateLabel, commits: [commit] });
    }
  }
  return groups;
}

function readCommitChecks(
  checks: GitHubChecksSummary | null | undefined,
  sha: string
): { state: string; complete: number; total: number } | null {
  if (!checks || checks.sha !== sha) return null;
  const total = checks.check_runs.length + checks.statuses.length;
  if (total === 0) return null;
  const complete =
    checks.check_runs.filter((run) => run.status === "completed").length +
    checks.statuses.filter((status) => status.state !== "pending").length;
  return { state: checks.state, complete, total };
}

function CommitCheckStatus({
  checks,
}: {
  checks: { state: string; complete: number; total: number };
}): React.ReactNode {
  const isSuccess = checks.state === "success";
  const isFailure = checks.state === "failure";
  const Icon = isSuccess
    ? CheckmarkCircle01Icon
    : isFailure
      ? CancelCircleIcon
      : CircleDotDashedIcon;
  return (
    <span
      className={`inline-flex items-center gap-1 font-medium tabular-nums ${
        isSuccess
          ? "text-success-6"
          : isFailure
            ? "text-danger-6"
            : "text-warning-6"
      }`}
    >
      <AnyIcon icon={Icon} size={13} strokeWidth={1.9} aria-hidden />
      {checks.complete} / {checks.total}
    </span>
  );
}

function PrCommitCard({
  commit,
  checks,
  onSelect,
}: {
  commit: PrCommitRow;
  checks: GitHubChecksSummary | null | undefined;
  onSelect: (commit: PrCommitRow) => void;
}): React.ReactNode {
  const { t } = useTranslation("common");
  const copySha = useCallback(() => copyText(commit.sha), [commit.sha]);
  const { copied, handleCopy } = useCopyCheck(copySha);
  const commitChecks = readCommitChecks(checks, commit.sha);
  const relativeTime = formatRelativeTime(commit.author.date, "long");
  const actorInitial = commit.actor.login.trim().charAt(0).toUpperCase();

  return (
    <article className="group flex min-w-0 items-center overflow-hidden rounded-xl border border-border-1 bg-primary-container transition-colors hover:border-border-2">
      <button
        type="button"
        className="min-w-0 flex-1 px-3 py-3 text-left"
        onClick={() => onSelect(commit)}
        title={commit.message || commit.summary}
        aria-label={t("git.pr.commits.viewCommit", {
          defaultValue: "View commit {{sha}}: {{summary}}",
          sha: commit.short_sha,
          summary: commit.summary,
        })}
      >
        <span className="block break-words text-[13px] font-semibold leading-5 text-text-1">
          {commit.summary}
        </span>
        {commit.description ? (
          <span className="mt-1 line-clamp-2 whitespace-pre-wrap text-[12px] leading-5 text-text-2">
            {commit.description}
          </span>
        ) : null}
        <span className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12px] text-text-3">
          <Avatar size={18} src={commit.actor.avatarUrl}>
            {actorInitial}
          </Avatar>
          <span className="font-medium text-text-2">{commit.actor.login}</span>
          <span>{t("git.pr.commits.committed", "committed")}</span>
          {commit.author.date ? (
            <time
              dateTime={commit.author.date}
              title={formatDate(commit.author.date)}
            >
              {relativeTime}
            </time>
          ) : null}
          {commitChecks ? (
            <>
              <span aria-hidden>·</span>
              <CommitCheckStatus checks={commitChecks} />
            </>
          ) : null}
          {commit.verified ? (
            <>
              <span aria-hidden>·</span>
              <span className="inline-flex items-center gap-1 text-success-6">
                <HugeiconsIcon
                  icon={SecurityCheckIcon}
                  data-icon="shield-check"
                  size={13}
                  strokeWidth={1.9}
                  aria-hidden
                />
                {t("git.pr.commits.verified", "Verified")}
              </span>
            </>
          ) : null}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-0.5 pr-2">
        <code className="hidden px-1 text-[11px] text-text-3 sm:inline">
          {commit.short_sha}
        </code>
        <ActivityHeaderActionButton
          icon={
            copied ? (
              <HugeiconsIcon
                icon={Tick01Icon}
                data-icon="check"
                size={13}
                strokeWidth={1.75}
              />
            ) : (
              <HugeiconsIcon
                icon={Copy01Icon}
                data-icon="copy"
                size={13}
                strokeWidth={1.75}
              />
            )
          }
          label={
            copied
              ? t("status.copied")
              : t("git.pr.commits.copySha", "Copy commit SHA")
          }
          onClick={(event) => {
            event.stopPropagation();
            handleCopy();
          }}
        />
        <ActivityHeaderActionButton
          icon={
            <HugeiconsIcon
              icon={CodeIcon}
              data-icon="code-2"
              size={14}
              strokeWidth={1.75}
            />
          }
          label={t("git.pr.commits.viewDetails", "View commit details")}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(commit);
          }}
        />
      </div>
    </article>
  );
}

interface PrCommitsTabProps {
  commits: Record<string, unknown>[];
  prNumber: number;
  repoPath: string;
  repoId?: string;
  loading: boolean;
  checks?: GitHubChecksSummary | null;
  selectedCommitSha?: string | null;
  onSelectedCommitShaChange?: (sha: string | null) => void;
  onFileSelect?: (path: string) => void;
}

export const PrCommitsTab: React.FC<PrCommitsTabProps> = ({
  commits,
  prNumber,
  repoPath,
  repoId,
  loading,
  checks,
  selectedCommitSha: controlledSelectedCommitSha,
  onSelectedCommitShaChange,
  onFileSelect,
}) => {
  const { t } = useTranslation("common");
  const [internalSelectedCommitSha, setInternalSelectedCommitSha] = useState<
    string | null
  >(null);
  const selectedCommitSha =
    controlledSelectedCommitSha !== undefined
      ? controlledSelectedCommitSha
      : internalSelectedCommitSha;
  const updateSelectedCommitSha = useCallback(
    (sha: string | null) => {
      if (controlledSelectedCommitSha !== undefined) {
        onSelectedCommitShaChange?.(sha);
        return;
      }
      setInternalSelectedCommitSha(sha);
    },
    [controlledSelectedCommitSha, onSelectedCommitShaChange]
  );
  const unknownAuthor = t("git.pr.unknownAuthor", "Unknown");
  const unknownDate = t("git.pr.commits.unknownDate", "Unknown date");

  const rows = useMemo(
    () =>
      commits
        .map((commit) => mapPrCommit(commit, unknownAuthor))
        .filter((c): c is PrCommitRow => c !== null),
    [commits, unknownAuthor]
  );
  const groups = useMemo(
    () => groupCommits(rows, unknownDate),
    [rows, unknownDate]
  );
  const selected = useMemo(
    () => rows.find((commit) => commit.sha === selectedCommitSha) ?? null,
    [rows, selectedCommitSha]
  );

  const handleSelect = useCallback(
    (commit: PrCommitRow) => {
      updateSelectedCommitSha(commit.sha);
    },
    [updateSelectedCommitSha]
  );

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
            icon={
              <HugeiconsIcon
                icon={ArrowLeft01Icon}
                data-icon="chevron-left"
                size={14}
                strokeWidth={2}
              />
            }
            onClick={() => updateSelectedCommitSha(null)}
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
      <div
        className={`${DETAIL_PANEL_TOKENS.headerWidth} flex flex-col gap-5 px-4 py-4`}
      >
        {groups.map((group) => (
          <section key={group.key}>
            <div className="flex h-5 items-center gap-2 text-[12px] font-medium text-text-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-fill-2 text-text-2">
                <HugeiconsIcon
                  icon={GitCommitHorizontalIcon}
                  data-icon="git-commit-horizontal"
                  size={13}
                  strokeWidth={1.8}
                  aria-hidden
                />
              </span>
              <span>
                {t("git.pr.commits.onDate", {
                  defaultValue: "Commits on {{date}}",
                  date: group.dateLabel,
                })}
              </span>
            </div>
            <div className="relative ml-2.5 mt-2 border-l border-border-1 pl-5">
              <div className="flex min-w-0 flex-col gap-2">
                {group.commits.map((commit) => (
                  <PrCommitCard
                    key={commit.sha}
                    commit={commit}
                    checks={checks}
                    onSelect={handleSelect}
                  />
                ))}
              </div>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};

PrCommitsTab.displayName = "PrCommitsTab";
