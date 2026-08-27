/**
 * PrFlowHeader
 *
 * GitHub-style flow title for the PR Conversation tab: the large PR title with
 * its muted #number, then a status pill followed by the merge-flow sentence
 * ("{author} wants to merge {n} commits into {base} from {head}") with the
 * branch names as code pills, a copy-branch action, and the +/− diff stat.
 */
import { Copy } from "lucide-react";
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import type { PrFile } from "@src/api/tauri/github";
import { IconButton } from "@src/components/IconButton";
import Message from "@src/components/Message";
import PrStatusBadge from "@src/components/PrStatusBadge";
import GitHubFlowHeader from "@src/modules/shared/components/GitHubFlowHeader";
import type { PrIdentity } from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";
import { copyText } from "@src/util/data/clipboard";

interface PrFlowActor {
  login: string;
  avatarUrl: string;
}

function readNumber(
  detail: Record<string, unknown> | null,
  key: string
): number | null {
  const value = detail?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readActor(
  detail: Record<string, unknown> | null,
  key: string
): PrFlowActor | null {
  const value = detail?.[key];
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.login !== "string" || !record.login) return null;
  return {
    login: record.login,
    avatarUrl: typeof record.avatar_url === "string" ? record.avatar_url : "",
  };
}

function BranchPill({ name }: { name: string }): React.ReactNode {
  return (
    <code
      className="inline-block max-w-[220px] truncate rounded-md bg-primary-1 px-1.5 py-0.5 align-bottom font-mono text-[11px] leading-4 text-primary-6"
      title={name}
    >
      {name}
    </code>
  );
}

interface PrFlowHeaderProps {
  identity: PrIdentity;
  detail: Record<string, unknown> | null;
  baseBranch: string;
  /** Fallback commit count when the PR detail payload has none. */
  commitCount: number;
  /** Fallback source for the +/− diff stat when the detail payload has none. */
  files: PrFile[];
}

export function PrFlowHeader({
  identity,
  detail,
  baseBranch,
  commitCount,
  files,
}: PrFlowHeaderProps): React.ReactNode {
  const { t } = useTranslation("common");
  const author = readActor(detail, "user");
  const merged = identity.status === "merged";
  // Merged PRs credit the merger, matching GitHub's flow sentence.
  const actor = (merged ? readActor(detail, "merged_by") : null) ?? author;
  const commits = readNumber(detail, "commits") ?? commitCount;
  const additions =
    readNumber(detail, "additions") ??
    files.reduce((total, file) => total + file.additions, 0);
  const deletions =
    readNumber(detail, "deletions") ??
    files.reduce((total, file) => total + file.deletions, 0);

  const copyHeadBranch = useCallback(async () => {
    try {
      await copyText(identity.headBranch);
      Message.success(t("git.pr.flow.branchCopied", "Branch name copied"));
    } catch (error) {
      Message.error(error instanceof Error ? error.message : String(error));
    }
  }, [identity.headBranch, t]);

  const verbPhrase = merged
    ? t("git.pr.flow.mergedCommitsInto", {
        count: commits,
        defaultValue: "merged {{count}} commit into",
        defaultValue_other: "merged {{count}} commits into",
      })
    : t("git.pr.flow.wantsToMergeCommitsInto", {
        count: commits,
        defaultValue: "wants to merge {{count}} commit into",
        defaultValue_other: "wants to merge {{count}} commits into",
      });

  return (
    <GitHubFlowHeader
      testIdPrefix="pr-flow"
      ariaLabel={t("git.pr.summary.label", "Pull request summary")}
      title={identity.title}
      number={identity.number}
      status={<PrStatusBadge status={identity.status} size="sm" showIcon />}
      actor={actor}
      unknownActorLabel={t("git.pr.unknownAuthor", "Unknown")}
    >
      <span>{verbPhrase}</span>
      <BranchPill name={baseBranch} />
      <span>{t("git.pr.flow.from", "from")}</span>
      <BranchPill name={identity.headBranch} />
      <IconButton
        size="sm"
        aria-label={t("git.pr.flow.copyHeadBranch", "Copy head branch name")}
        title={t("git.pr.flow.copyHeadBranch", "Copy head branch name")}
        className="text-text-3 hover:text-text-1"
        onClick={() => void copyHeadBranch()}
        data-testid="pr-flow-copy-branch"
      >
        <Copy size={12} strokeWidth={1.75} aria-hidden />
      </IconButton>
      <span className="inline-flex items-center gap-1 tabular-nums">
        <span className="text-success-6">
          +{additions.toLocaleString("en-US")}
        </span>
        <span className="text-danger-6">
          -{deletions.toLocaleString("en-US")}
        </span>
      </span>
    </GitHubFlowHeader>
  );
}
