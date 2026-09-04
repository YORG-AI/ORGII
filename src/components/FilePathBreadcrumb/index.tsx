/**
 * FilePathBreadcrumb
 *
 * Slash-separated path breadcrumb with the file name emphasized. Used by
 * changed-file rows (collapsed middle) and file-path hover tooltips
 * (`maxSegments={null}` renders the untruncated path).
 */
import React, { useMemo } from "react";

import { HugeiconsIcon, SlashIcon } from "@src/icons";

const PATH_SEPARATOR = (
  <HugeiconsIcon
    icon={SlashIcon}
    data-icon="slash"
    size={10}
    strokeWidth={1.5}
    className="shrink-0 -rotate-12 text-text-4/50"
  />
);

const MAX_VISIBLE_SEGMENTS = 4;

interface FilePathBreadcrumbProps {
  path: string;
  /**
   * Segments kept before the middle collapses to an ellipsis.
   * `null` renders every segment.
   * @default 4
   */
  maxSegments?: number | null;
  className?: string;
}

const FilePathBreadcrumb: React.FC<FilePathBreadcrumbProps> = ({
  path,
  maxSegments = MAX_VISIBLE_SEGMENTS,
  className = "",
}) => {
  const segments = useMemo(() => path.split("/").filter(Boolean), [path]);

  const displaySegments = useMemo(() => {
    if (maxSegments === null || segments.length <= maxSegments) return segments;
    const tailCount = Math.max(1, maxSegments - 2);
    return [segments[0], "…", ...segments.slice(-tailCount)];
  }, [segments, maxSegments]);

  const lastIndex = displaySegments.length - 1;
  const showsFullPath = maxSegments === null;

  return (
    <span
      className={`inline-flex max-w-full min-w-0 items-center gap-0.5 text-xs ${
        showsFullPath ? "flex-wrap whitespace-normal" : "whitespace-nowrap"
      } ${className}`}
    >
      {displaySegments.map((segment, index) => {
        const isFile = index === lastIndex;
        return (
          <span
            key={`${segment}-${index}`}
            className={`inline-flex max-w-full min-w-0 items-center gap-0.5 ${
              showsFullPath ? "shrink-0" : ""
            }`}
          >
            {index > 0 && PATH_SEPARATOR}
            <span
              className={`${
                isFile ? "font-medium text-text-1" : "text-text-2"
              } ${showsFullPath ? "min-w-0 break-all" : ""}`}
            >
              {segment}
            </span>
          </span>
        );
      })}
    </span>
  );
};

export default FilePathBreadcrumb;
