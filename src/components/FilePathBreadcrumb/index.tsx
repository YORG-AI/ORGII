/**
 * FilePathBreadcrumb
 *
 * Slash-separated path breadcrumb with the file name emphasized. Used by
 * changed-file rows (collapsed middle) and file-path hover tooltips
 * (`maxSegments={null}` renders the untruncated path).
 */
import { Slash } from "lucide-react";
import React, { useMemo } from "react";

const PATH_SEPARATOR = (
  <Slash
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

  return (
    <span className={`inline-flex items-center gap-0.5 text-xs ${className}`}>
      {displaySegments.map((segment, index) => {
        const isFile = index === lastIndex;
        return (
          <React.Fragment key={index}>
            {index > 0 && PATH_SEPARATOR}
            <span
              className={isFile ? "font-medium text-text-1" : "text-text-2"}
            >
              {segment}
            </span>
          </React.Fragment>
        );
      })}
    </span>
  );
};

export default FilePathBreadcrumb;
export type { FilePathBreadcrumbProps };
