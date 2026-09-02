import React, { memo, useCallback } from "react";

import type { FileChange, FileChangeStatus } from "@src/api/http/project";
import Button from "@src/components/Button";
import FilePathBreadcrumb from "@src/components/FilePathBreadcrumb";

import DiffSummary from "./DiffSummary";

const STATUS_CONFIG: Record<
  FileChangeStatus,
  { label: string; className: string }
> = {
  added: { label: "A", className: "bg-success-6/15 text-success-6" },
  modified: { label: "M", className: "bg-warning-6/15 text-warning-6" },
  deleted: { label: "D", className: "bg-danger-6/15 text-danger-6" },
  renamed: { label: "R", className: "bg-primary-6/15 text-primary-6" },
};

interface FileRowProps {
  file: FileChange;
  commentCounts?: { errors: number; warnings: number };
  onClick?: (filePath: string) => void;
}

const FileRow: React.FC<FileRowProps> = ({ file, commentCounts, onClick }) => {
  const config = STATUS_CONFIG[file.status];

  const handleClick = useCallback(() => {
    onClick?.(file.path);
  }, [onClick, file.path]);

  const renamedFrom =
    file.status === "renamed" && file.old_path ? file.old_path : undefined;

  return (
    <Button
      variant="tertiary"
      size="small"
      onClick={handleClick}
      title={renamedFrom ? `${file.path} ← ${renamedFrom}` : file.path}
      className="flex! w-full items-center gap-2 rounded-md! px-2! py-1.5! text-left"
    >
      <span
        className={`inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded text-[9px] font-bold ${config.className}`}
      >
        {config.label}
      </span>

      <span className="min-w-0 flex-1 overflow-hidden">
        <FilePathBreadcrumb path={file.path} />
        {renamedFrom && (
          <span className="ml-1 text-[10px] text-text-4">
            ← {renamedFrom.split("/").pop()}
          </span>
        )}
      </span>

      {commentCounts && commentCounts.errors > 0 && (
        <span className="rounded bg-danger-6/15 px-1 py-px text-[10px] font-medium text-danger-6">
          ✗{commentCounts.errors}
        </span>
      )}
      {commentCounts && commentCounts.warnings > 0 && (
        <span className="rounded bg-warning-6/15 px-1 py-px text-[10px] font-medium text-warning-6">
          ⚠{commentCounts.warnings}
        </span>
      )}

      <DiffSummary added={file.lines_added} removed={file.lines_removed} />
    </Button>
  );
};

export default memo(FileRow);
