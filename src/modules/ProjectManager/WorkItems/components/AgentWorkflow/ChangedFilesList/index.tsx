import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  DiffStats,
  FileChangeStatus,
  ReviewComment,
} from "@src/api/http/project";
import Button from "@src/components/Button";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  HugeiconsIcon,
  SquareArrowUpRight02Icon,
} from "@src/icons";

import DiffSummary from "./DiffSummary";
import FileRow from "./FileRow";

interface ChangedFilesListProps {
  diffStats?: DiffStats;
  reviewComments?: ReviewComment[];
  isLive?: boolean;
  onOpenFileDiff?: (filePath: string) => void;
  onReviewAllFiles?: (filePaths: string[]) => void;
}

const ChangedFilesList: React.FC<ChangedFilesListProps> = ({
  diffStats,
  reviewComments = [],
  isLive,
  onOpenFileDiff,
  onReviewAllFiles,
}) => {
  const { t } = useTranslation("projects");
  const [expanded, setExpanded] = useState(false);

  const files = useMemo(() => diffStats?.files ?? [], [diffStats?.files]);
  const hasFiles = files.length > 0;
  const filesCount = diffStats?.files_changed ?? files.length;

  const commentCountByFile = useMemo(() => {
    const counts: Record<string, { errors: number; warnings: number }> = {};
    for (const comment of reviewComments) {
      if (!comment.file_path) continue;
      const entry = (counts[comment.file_path] ??= {
        errors: 0,
        warnings: 0,
      });
      if (comment.severity === "error") entry.errors++;
      else if (comment.severity === "warning") entry.warnings++;
    }
    return counts;
  }, [reviewComments]);

  const sortedFiles = useMemo(() => {
    if (!hasFiles) return [];
    return [...files].sort((fileA, fileB) => {
      const aHasComments = commentCountByFile[fileA.path] ? 1 : 0;
      const bHasComments = commentCountByFile[fileB.path] ? 1 : 0;
      if (bHasComments !== aHasComments) return bHasComments - aHasComments;

      const statusOrder = (status: FileChangeStatus): number => {
        switch (status) {
          case "added":
            return 0;
          case "modified":
            return 1;
          case "renamed":
            return 2;
          case "deleted":
            return 3;
        }
      };
      const statusDiff = statusOrder(fileA.status) - statusOrder(fileB.status);
      if (statusDiff !== 0) return statusDiff;
      return fileA.path.localeCompare(fileB.path);
    });
  }, [files, hasFiles, commentCountByFile]);

  const reviewableFiles = useMemo(
    () => files.filter((file) => file.status !== "deleted"),
    [files]
  );

  const handleReviewAll = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (reviewableFiles.length === 0) return;
      if (onReviewAllFiles) {
        onReviewAllFiles(reviewableFiles.map((file) => file.path));
      } else if (onOpenFileDiff) {
        for (const file of reviewableFiles) {
          onOpenFileDiff(file.path);
        }
      }
    },
    [onReviewAllFiles, onOpenFileDiff, reviewableFiles]
  );

  if (!diffStats || filesCount === 0) return null;

  return (
    <div className="rounded-md bg-fill-1">
      <div className="flex items-center gap-1">
        <Button
          variant="tertiary"
          size="small"
          onClick={() => setExpanded(!expanded)}
          icon={
            expanded ? (
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                data-icon="chevron-down"
                size={13}
                className="text-text-4"
              />
            ) : (
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={13}
                className="text-text-4"
              />
            )
          }
          className="!flex min-w-0 flex-1 items-center justify-between !rounded-md !px-3 !py-2"
        >
          <span className="text-xs font-medium text-text-1">
            {t("workItems.changedFiles.title")} ({filesCount})
          </span>
          {isLive && (
            <span className="flex items-center gap-1 text-[10px] text-primary-6">
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-primary-6" />
              {t("workItems.changedFiles.live")}
            </span>
          )}
          <span className="ml-auto">
            <DiffSummary
              added={diffStats.lines_added}
              removed={diffStats.lines_removed}
            />
          </span>
        </Button>

        {(onReviewAllFiles || onOpenFileDiff) && reviewableFiles.length > 0 && (
          <button
            onClick={handleReviewAll}
            title={t("workItems.changedFiles.reviewInEditor")}
            className="mr-2 shrink-0 rounded-md p-1.5 text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
          >
            <HugeiconsIcon
              icon={SquareArrowUpRight02Icon}
              data-icon="square-arrow-out-up-right"
              size={13}
            />
          </button>
        )}
      </div>

      {expanded && hasFiles && (
        <div className="space-y-0.5 px-2 pb-2">
          {sortedFiles.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              commentCounts={commentCountByFile[file.path]}
              onClick={onOpenFileDiff}
            />
          ))}
          {isLive && (
            <div className="px-2 py-1.5 text-[10px] text-text-4">
              {t("workItems.changedFiles.agentWorking")}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ChangedFilesList;
