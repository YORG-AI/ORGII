/**
 * GitHubIssueFlowHeader
 *
 * GitHub-style flow title for the issue thread, sharing the exact format used
 * by the pull-request detail: the large title with its muted #number, then a
 * status pill and the "{author} opened this issue · N comments" sentence.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import type { GitHubIssue } from "@src/api/tauri/github";
import {
  CheckmarkCircle01Icon,
  CircleDotIcon,
  HugeiconsIcon,
} from "@src/icons";
import { ActivityTimestamp } from "@src/modules/shared/components/ActivityTimeline";
import GitHubFlowHeader from "@src/modules/shared/components/GitHubFlowHeader";

export function GitHubIssueFlowHeader({
  issue,
}: {
  issue: GitHubIssue;
}): React.ReactNode {
  const { t } = useTranslation("common");
  const isOpen = issue.state === "open";

  return (
    <GitHubFlowHeader
      testIdPrefix="issue-flow"
      title={issue.title}
      number={issue.number}
      status={
        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            isOpen ? "bg-success-1 text-success-6" : "bg-purple-1 text-purple-6"
          }`}
        >
          {isOpen ? (
            <HugeiconsIcon
              icon={CircleDotIcon}
              data-icon="circle-dot"
              size={10}
              aria-hidden
            />
          ) : (
            <HugeiconsIcon
              icon={CheckmarkCircle01Icon}
              data-icon="check-circle-2"
              size={10}
              aria-hidden
            />
          )}
          {isOpen
            ? t("git.issues.status.open", "Open")
            : t("git.issues.status.closed", "Closed")}
        </span>
      }
      actor={{ login: issue.user.login, avatarUrl: issue.user.avatar_url }}
      unknownActorLabel={t("git.pr.unknownAuthor", "Unknown")}
    >
      <span>{t("git.issues.activity.opened", "opened this issue")}</span>
      <ActivityTimestamp timestamp={issue.created_at} />
      <span aria-hidden>·</span>
      <span>
        {t("git.issues.commentCount", {
          count: issue.comments,
          defaultValue: "{{count}} comment",
          defaultValue_other: "{{count}} comments",
        })}
      </span>
    </GitHubFlowHeader>
  );
}

export default GitHubIssueFlowHeader;
