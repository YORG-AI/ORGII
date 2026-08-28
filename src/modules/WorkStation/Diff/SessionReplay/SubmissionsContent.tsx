import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { GitCommitInfo } from "@src/api/http/git/types";
import { Placeholder } from "@src/components/Placeholder";
import PrStatusBadge from "@src/components/PrStatusBadge";
import type { ExtractedGitArtifactData } from "@src/engines/SessionCore/core/types";
import {
  HugeiconsIcon,
  SquareArrowUpRightIcon,
  WorkflowCircle05Icon,
} from "@src/icons";
import GitCommitRow from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/GitHistoryContent/GitCommitRow";
import { truncateBranchLabel } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/PullRequestContent/prCardHelpers";
import {
  HEADER_BUTTON,
  TYPOGRAPHY,
} from "@src/modules/WorkStation/shared/tokens";
import { PR_STATUS_UNKNOWN } from "@src/shared/pr/prStatus";

export type SubmissionArtifactOrigin = "created" | "mentioned";

export type SubmissionArtifact = ExtractedGitArtifactData & {
  repoId?: string;
  repoPath?: string;
  origin?: SubmissionArtifactOrigin;
  /** Event ID where this artifact was extracted from (for replay navigation). */
  eventId?: string;
};

export type SubmissionCommit = Pick<
  GitCommitInfo,
  "sha" | "short_sha" | "summary"
> & {
  author?: GitCommitInfo["author"] | null;
  repoId?: string;
  repoPath?: string;
  origin?: SubmissionArtifactOrigin;
  /** Event ID where this commit was first mentioned (extracted from text/shell, not orgtrack-linked). */
  mentionedEventId?: string;
};

export interface PullRequestSubmission {
  key: string;
  url?: string;
  repoFullName?: string;
  prNumber?: number;
  prTitle?: string;
  sourceBranch?: string;
  targetBranch?: string;
  origin?: SubmissionArtifactOrigin;
  /** Normalized PR status (`open` / `merged` / `closed` / `draft`), or
   * `unknown` when the GitHub read failed. Injected by the parent after a
   * batch GitHub fetch; absent while the first read is in flight, or for rows
   * missing repoFullName-or-prNumber, which can never be read. Those render as
   * `unknown` too — never as `open`, which would assert a state nothing
   * verified. */
  statusKey?: string;
}

export interface SubmissionsData {
  commits: SubmissionCommit[];
  pullRequests: PullRequestSubmission[];
}

interface SubmissionCommitsContentProps {
  commits: SubmissionCommit[];
  selectedCommitSha: string | null;
  onCommitSelect: (commit: SubmissionCommit) => void;
  emptyLabel: string;
}

interface SubmissionPullRequestsContentProps {
  pullRequests: PullRequestSubmission[];
  emptyLabel: string;
}

function extractCommitSha(artifact: SubmissionArtifact): string {
  if (artifact.sha) return artifact.sha.trim();
  const match = artifact.url?.match(
    /github\.com\/[^/]+\/[^/]+\/commit\/([a-f0-9]{7,40})/i
  );
  return match?.[1] ?? "";
}

function commitFromArtifact(
  artifact: SubmissionArtifact
): SubmissionCommit | null {
  const sha = extractCommitSha(artifact);
  const shortSha = artifact.shortSha ?? sha.slice(0, 7);
  if (!sha && !shortSha) return null;
  return {
    sha: sha || shortSha,
    short_sha: shortSha || sha.slice(0, 7),
    summary: artifact.subject ?? shortSha ?? sha,
    author: null,
    repoId: artifact.repoId,
    repoPath: artifact.repoPath,
    origin: artifact.origin,
    mentionedEventId: artifact.eventId,
  };
}

function getSubmissionDedupeKey(artifact: SubmissionArtifact): string | null {
  if (artifact.url) return `${artifact.kind}:url:${artifact.url}`;
  if (artifact.kind === "commit" && artifact.sha)
    return `commit:sha:${artifact.sha}`;
  if (
    artifact.kind === "pullRequest" &&
    artifact.repoFullName &&
    artifact.prNumber
  ) {
    return `pullRequest:${artifact.repoFullName}#${artifact.prNumber}`;
  }
  return null;
}

export function deriveSubmissionsData(
  artifacts: readonly SubmissionArtifact[]
): SubmissionsData {
  const seenKeys = new Set<string>();
  const commits: SubmissionCommit[] = [];
  const pullRequests: PullRequestSubmission[] = [];

  for (const artifact of artifacts) {
    const key = getSubmissionDedupeKey(artifact);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);

    if (artifact.kind === "commit") {
      const commit = commitFromArtifact(artifact);
      if (commit) commits.push(commit);
      continue;
    }

    pullRequests.push({
      key,
      url: artifact.url,
      repoFullName: artifact.repoFullName,
      prNumber: artifact.prNumber,
      prTitle: artifact.prTitle,
      sourceBranch: artifact.sourceBranch,
      targetBranch: artifact.targetBranch,
      origin: artifact.origin,
    });
  }

  return { commits, pullRequests };
}

function SubmissionArtifactLabel({
  kind,
  origin,
}: {
  kind: "commit" | "pullRequest";
  origin?: SubmissionArtifactOrigin;
}) {
  const { t } = useTranslation("sessions");
  const label = t(
    `simulator.replay.diffApp.submissions.labels.${origin === "created" ? "created" : "mentioned"}.${kind}`,
    origin === "created"
      ? kind === "commit"
        ? "Created commit"
        : "Created PR"
      : kind === "commit"
        ? "Mentioned commit"
        : "Mentioned PR"
  );

  return (
    <span className="shrink-0 rounded-full border border-border-2 bg-fill-1 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-3">
      {label}
    </span>
  );
}

const PullRequestSubmissionRow: React.FC<{
  pullRequest: PullRequestSubmission;
}> = memo(({ pullRequest }) => {
  const { t } = useTranslation("common");
  const title = pullRequest.prTitle || t("labels.pullRequest", "Pull request");
  const numberLabel = pullRequest.prNumber ? `#${pullRequest.prNumber}` : null;
  const branchLabel = pullRequest.sourceBranch
    ? pullRequest.targetBranch
      ? `${pullRequest.sourceBranch} → ${pullRequest.targetBranch}`
      : pullRequest.sourceBranch
    : null;
  const statusKey = pullRequest.statusKey ?? PR_STATUS_UNKNOWN;

  return (
    <div className="border-b border-fill-2 px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <PrStatusBadge status={statusKey} showDot size="sm" />
        <SubmissionArtifactLabel
          kind="pullRequest"
          origin={pullRequest.origin}
        />
        {numberLabel && (
          <span
            className={`${TYPOGRAPHY.secondary} font-medium tabular-nums text-text-3`}
          >
            {numberLabel}
          </span>
        )}
        {pullRequest.url && (
          <a
            href={pullRequest.url}
            target="_blank"
            rel="noreferrer"
            className={`${HEADER_BUTTON.action} ml-auto`}
            aria-label={t("actions.openOnGitHub", "Open on GitHub")}
            title={t("actions.openOnGitHub", "Open on GitHub")}
          >
            <HugeiconsIcon
              icon={SquareArrowUpRightIcon}
              data-icon="square-arrow-out-up-right"
              size={14}
            />
          </a>
        )}
      </div>
      <div
        className="mt-1 line-clamp-2 text-[12px] font-medium leading-snug text-text-1"
        title={title}
      >
        {title}
      </div>
      {(branchLabel || pullRequest.repoFullName) && (
        <div className="mt-1 flex min-w-0 items-center gap-1 text-[11px] text-text-3">
          <HugeiconsIcon
            icon={WorkflowCircle05Icon}
            data-icon="git-branch"
            size={12}
            className="shrink-0"
          />
          <span className="truncate">
            {branchLabel
              ? truncateBranchLabel(branchLabel)
              : pullRequest.repoFullName}
          </span>
        </div>
      )}
    </div>
  );
});

PullRequestSubmissionRow.displayName = "PullRequestSubmissionRow";

export const SubmissionCommitsContent: React.FC<SubmissionCommitsContentProps> =
  memo(({ commits, selectedCommitSha, onCommitSelect, emptyLabel }) => {
    const handleCommitSelect = useCallback(
      (commit: SubmissionCommit) => {
        onCommitSelect(commit);
      },
      [onCommitSelect]
    );

    const commitRows = useMemo(() => {
      // Group consecutive rows by `origin` and render the label once per group
      // (group header), not per row — repeating the same "MENTIONED COMMIT"
      // chip above every entry is visual noise when N entries share an origin.
      const rendered: React.ReactNode[] = [];
      let previousOrigin: SubmissionArtifactOrigin | undefined | "__none__" =
        "__none__";

      for (const commit of commits) {
        const originKey = commit.origin ?? undefined;
        if (originKey !== previousOrigin) {
          rendered.push(
            <div
              key={`origin-${commit.sha}`}
              className="flex items-center px-3 pb-1 pt-2"
            >
              <SubmissionArtifactLabel kind="commit" origin={originKey} />
            </div>
          );
          previousOrigin = originKey;
        }

        rendered.push(
          <div key={commit.sha} className="border-b border-fill-2">
            <GitCommitRow
              commit={commit}
              isSelected={commit.sha === selectedCommitSha}
              onSelect={handleCommitSelect}
              showGraphPlaceholder
            />
          </div>
        );
      }

      return rendered;
    }, [commits, handleCommitSelect, selectedCommitSha]);

    if (commits.length === 0) {
      return (
        <Placeholder
          variant="empty"
          placement="sidebar"
          title={emptyLabel}
          fillParentHeight
        />
      );
    }

    return <div className="overflow-auto scrollbar-hide">{commitRows}</div>;
  });

SubmissionCommitsContent.displayName = "SubmissionCommitsContent";

export const SubmissionPullRequestsContent: React.FC<SubmissionPullRequestsContentProps> =
  memo(({ pullRequests, emptyLabel }) => {
    if (pullRequests.length === 0) {
      return (
        <Placeholder
          variant="empty"
          placement="sidebar"
          title={emptyLabel}
          fillParentHeight
        />
      );
    }

    return (
      <div className="overflow-auto scrollbar-hide">
        {pullRequests.map((pullRequest) => (
          <PullRequestSubmissionRow
            key={pullRequest.key}
            pullRequest={pullRequest}
          />
        ))}
      </div>
    );
  });

SubmissionPullRequestsContent.displayName = "SubmissionPullRequestsContent";
