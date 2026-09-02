import React, { memo, useMemo } from "react";

import type { CommitDiffResult } from "@src/api/http/git/types";
import DiffStatsBadge from "@src/components/DiffStatsBadge";
import { FileHeader } from "@src/modules/WorkStation/shared";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

interface CommitTabHeaderProps {
  shortSha: string;
  commitMessage: string;
  commitDiff: CommitDiffResult | null;
  publishToWorkstationHeader: boolean;
}

/**
 * Renders the commit breadcrumb (shortSha › message [author + stats]) either
 * inline as a 40px file bar or in the global Workstation tab-header strip.
 */
export const CommitTabHeader: React.FC<CommitTabHeaderProps> = memo(
  function CommitTabHeader({
    shortSha,
    commitMessage,
    commitDiff,
    publishToWorkstationHeader,
  }) {
    const extraActions = useMemo(
      () =>
        commitDiff?.author || commitDiff?.stats ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {commitDiff?.author && (
              <span className="shrink-0 text-[12px] text-text-2">
                {commitDiff.author.name}
              </span>
            )}
            {commitDiff?.author?.date && (
              <span className="shrink-0 text-[12px] text-text-3">
                {formatRelativeTime(commitDiff.author.date, "nano")}
              </span>
            )}
            {commitDiff?.stats && (
              <DiffStatsBadge
                additions={commitDiff.stats.insertions}
                deletions={commitDiff.stats.deletions}
              />
            )}
          </div>
        ) : null,
      [commitDiff]
    );

    // The caller-supplied `commitMessage` can be a placeholder (the short SHA
    // itself) when the commit was selected before its `summary` had resolved
    // — that would render the breadcrumb as `21b1bc64 / 21b1bc64`. Prefer the
    // authoritative message from `commitDiff` once it has loaded, and fall
    // back to the caller's value only while the diff is still in flight.
    const resolvedMessage = commitDiff?.summary?.trim() || commitMessage;
    const breadcrumbTitle =
      resolvedMessage && resolvedMessage !== shortSha ? resolvedMessage : "";
    const breadcrumbPath = breadcrumbTitle
      ? `${shortSha}/${breadcrumbTitle}`
      : shortSha;

    return (
      <FileHeader
        filePath={breadcrumbPath}
        useFileTypeIcon={false}
        disableNavigation
        plainTitle={false}
        extraActions={extraActions}
        publishToHost={publishToWorkstationHeader ? "code" : undefined}
      />
    );
  }
);
