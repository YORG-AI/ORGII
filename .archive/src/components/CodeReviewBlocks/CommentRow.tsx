import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ReviewComment } from "@src/api/http/project";
import Button from "@src/components/Button";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Copy01Icon,
  HugeiconsIcon,
} from "@src/icons";
import { copyText } from "@src/util/data/clipboard";

import ReviewSeverityIcon from "./ReviewSeverityIcon";

interface CommentRowProps {
  comment: ReviewComment;
  resolved?: string;
  onOpenFileAtLine?: (filePath: string, line?: number) => void;
  /** Hide the severity icon (useful when already shown in a parent group header) */
  hideSeverity?: boolean;
}

const CommentRow: React.FC<CommentRowProps> = ({
  comment,
  resolved,
  onOpenFileAtLine,
  hideSeverity = false,
}) => {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const handleCopy = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      const text = [
        comment.file_path
          ? `${comment.file_path}${comment.line ? `:${comment.line}` : ""}`
          : null,
        comment.message,
      ]
        .filter(Boolean)
        .join(" — ");
      void copyText(text);
    },
    [comment]
  );

  const handleFileClick = useCallback(
    (event: React.MouseEvent) => {
      event.stopPropagation();
      if (comment.file_path && onOpenFileAtLine) {
        onOpenFileAtLine(comment.file_path, comment.line ?? undefined);
      }
    },
    [comment.file_path, comment.line, onOpenFileAtLine]
  );

  const shortFile = useMemo(() => {
    if (!comment.file_path) return null;
    const parts = comment.file_path.split("/");
    const fileName = parts.pop() ?? comment.file_path;
    return comment.line ? `${fileName}:${comment.line}` : fileName;
  }, [comment.file_path, comment.line]);

  const isLong = comment.message.length > 180 || comment.message.includes("\n");

  return (
    <div
      className="group/comment cursor-pointer rounded-lg px-3 py-2.5 transition-colors hover:bg-bg-2"
      onClick={() => isLong && setExpanded(!expanded)}
    >
      {/* Row 1: severity + file:line + actions */}
      <div className="flex items-center gap-2">
        {!hideSeverity && (
          <ReviewSeverityIcon
            severity={comment.severity}
            size={13}
            className="shrink-0"
          />
        )}
        {shortFile && (
          <Button
            variant="tertiary"
            size="mini"
            onClick={handleFileClick}
            title={comment.file_path ?? undefined}
            className="!px-0 !py-0 text-[12px] font-medium !text-text-1 hover:underline"
          >
            {shortFile}
          </Button>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {resolved && (
            <span className="rounded bg-success-1 px-1.5 py-0.5 text-[10px] font-medium text-success-6">
              {resolved}
            </span>
          )}
          <div className="hidden group-hover/comment:block">
            <Button
              variant="tertiary"
              size="mini"
              icon={
                <HugeiconsIcon
                  icon={Copy01Icon}
                  data-icon="copy"
                  size={12}
                  className="text-text-4 hover:text-text-2"
                />
              }
              onClick={handleCopy}
              title={t("common:actions.copy")}
              className="!px-0.5 !py-0.5"
            />
          </div>
        </div>
      </div>

      {/* Row 2: message */}
      <p
        className={`mt-1 text-[13px] leading-relaxed text-text-2 ${
          expanded ? "" : "line-clamp-2"
        }`}
      >
        {comment.message}
      </p>

      {isLong && (
        <span className="mt-0.5 hidden items-center text-text-4 group-hover/comment:inline-flex">
          {expanded ? (
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              data-icon="chevron-down"
              size={14}
            />
          ) : (
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              data-icon="chevron-right"
              size={14}
            />
          )}
        </span>
      )}
    </div>
  );
};

export default CommentRow;
