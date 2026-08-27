/**
 * BreadcrumbFileHeader Component
 *
 * VS Code-like breadcrumb navigation with dropdowns.
 * Each path segment is clickable and shows files/folders in that directory.
 */
import { ChevronRight } from "lucide-react";
import React, { useCallback, useMemo, useRef, useState } from "react";

import FileDropdown from "./FileDropdown";

export interface BreadcrumbFileHeaderProps {
  /** Full file path to display */
  filePath: string;
  /**
   * Explicit display segments for non-file breadcrumbs. When provided, labels
   * are not split on `/`, so titles containing slashes remain one segment.
   */
  displaySegments?: readonly BreadcrumbFileHeaderDisplaySegment[];
  /** Root repository path for navigation */
  repoPath?: string;
  /** Optional icon shown before the final segment (file name) */
  lastSegmentIcon?: React.ReactNode;
  /** Callback when a file is selected from dropdown */
  onFileSelect?: (filePath: string) => void;
  /** When true, breadcrumbs are display-only (no click, no dropdown) */
  disableNavigation?: boolean;
  /**
   * When true, show filePath as a single line (no splitting on `/`).
   * Use when the title is not a file path (e.g. concise shell command label).
   */
  plainTitle?: boolean;
  textSizeClassName?: string;
  className?: string;
  /**
   * Extra className applied to the last (deepest) segment span. Use to add
   * lifecycle-state styling — e.g. the chat-block loading shimmer — to the
   * filename/title portion without affecting the breadcrumb chevrons or
   * intermediate segments.
   */
  lastSegmentClassName?: string;
}

export interface BreadcrumbFileHeaderDisplaySegment {
  label: string;
  content?: React.ReactNode;
  icon?: React.ReactNode;
  onClick?: () => void;
  title?: string;
  /** Let this segment consume the remaining row width without ellipsis. */
  fillAvailableWidth?: boolean;
}

interface PathSegment {
  label: string;
  content?: React.ReactNode;
  fullPath: string;
  isLast: boolean;
  icon?: React.ReactNode;
  onClick?: () => void;
  title?: string;
  fillAvailableWidth?: boolean;
}

/**
 * Check if a path is a virtual file (no navigation, just display name)
 * Virtual files: don't contain "/" or start with special prefixes
 */
function isVirtualFile(filePath: string): boolean {
  if (!filePath) return false;
  if (!filePath.includes("/")) return true;
  if (filePath.startsWith("git-error-")) return true;
  if (filePath.startsWith("untitled:")) return true;
  return false;
}

const BreadcrumbFileHeader: React.FC<BreadcrumbFileHeaderProps> = ({
  filePath,
  displaySegments,
  repoPath,
  lastSegmentIcon,
  onFileSelect,
  disableNavigation,
  plainTitle = false,
  textSizeClassName = "text-[13px]",
  className = "",
  lastSegmentClassName = "",
}) => {
  const [activeSegmentPath, setActiveSegmentPath] = useState<string | null>(
    null
  );
  const segmentRefs = useRef<Map<string, HTMLSpanElement>>(new Map());
  const activeTriggerRef = useRef<HTMLSpanElement | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const pathSegments = useMemo(() => {
    if (!filePath) return [];

    if (
      plainTitle ||
      ((!displaySegments || displaySegments.length === 0) &&
        isVirtualFile(filePath))
    ) {
      return [
        {
          label: filePath,
          fullPath: filePath,
          isLast: true,
        },
      ];
    }

    const parts =
      displaySegments && displaySegments.length > 0
        ? [...displaySegments]
        : filePath
            .split("/")
            .filter(Boolean)
            .map((label) => ({ label }));
    const segments: PathSegment[] = [];

    parts.forEach((part, index) => {
      const fullPath = parts
        .slice(0, index + 1)
        .map((segment) => segment.label)
        .join("/");
      segments.push({
        ...part,
        fullPath: repoPath ? `${repoPath}/${fullPath}` : fullPath,
        isLast: index === parts.length - 1,
      });
    });

    return segments;
  }, [displaySegments, filePath, repoPath, plainTitle]);

  const scrollToRight = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollLeft = containerRef.current.scrollWidth;
    }
  }, []);

  React.useEffect(() => {
    scrollToRight();
  }, [pathSegments, scrollToRight]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(scrollToRight);
    observer.observe(container);
    return () => observer.disconnect();
  }, [scrollToRight]);

  const handleSegmentClick = useCallback(
    (segment: PathSegment) => {
      if (segment.onClick) {
        setActiveSegmentPath(null);
        segment.onClick();
        return;
      }
      if (disableNavigation || segment.isLast) {
        setActiveSegmentPath(null);
        return;
      }

      setActiveSegmentPath((prev) => {
        return prev === segment.fullPath ? null : segment.fullPath;
      });
    },
    [disableNavigation]
  );

  const handleFileSelect = useCallback(
    (selectedPath: string) => {
      setActiveSegmentPath(null);
      onFileSelect?.(selectedPath);
    },
    [onFileSelect]
  );

  const handleCloseDropdown = useCallback(() => {
    setActiveSegmentPath(null);
  }, []);

  React.useEffect(() => {
    if (activeSegmentPath) {
      activeTriggerRef.current =
        segmentRefs.current.get(activeSegmentPath) || null;
    } else {
      activeTriggerRef.current = null;
    }
  }, [activeSegmentPath]);

  return (
    <div
      ref={containerRef}
      className={`flex min-w-0 flex-1 items-center gap-0 ${
        plainTitle
          ? "overflow-x-hidden"
          : "flex-nowrap overflow-x-auto scrollbar-hide"
      } ${className}`.trim()}
    >
      {pathSegments.map((segment) => {
        const isActive = activeSegmentPath === segment.fullPath;
        const isLast = segment.isLast;
        const singleLineTitle = plainTitle && isLast;
        const isClickable =
          Boolean(segment.onClick) || (!disableNavigation && !isLast);
        const segmentIcon =
          segment.icon ?? (isLast ? lastSegmentIcon : undefined);

        return (
          <React.Fragment key={segment.fullPath}>
            <span
              ref={(el) => {
                if (el) {
                  segmentRefs.current.set(segment.fullPath, el);
                  if (isActive) {
                    activeTriggerRef.current = el;
                  }
                } else {
                  segmentRefs.current.delete(segment.fullPath);
                  if (activeTriggerRef.current === el) {
                    activeTriggerRef.current = null;
                  }
                }
              }}
              title={
                segment.title ??
                (singleLineTitle || (displaySegments && isLast)
                  ? filePath
                  : undefined)
              }
              className={`h-6 min-w-0 items-center px-1 ${textSizeClassName} leading-6 transition-colors ${
                singleLineTitle
                  ? "flex flex-1 truncate font-medium text-text-1"
                  : `inline-flex whitespace-nowrap ${
                      segment.fillAvailableWidth ? "flex-1" : "flex-shrink-0"
                    } ${
                      isLast && !segment.onClick
                        ? "font-medium text-text-1"
                        : isClickable
                          ? "cursor-pointer text-text-2 hover:text-text-1 hover:underline hover:decoration-text-1"
                          : "text-text-2"
                    }`
              } ${isActive && !disableNavigation ? "text-text-1 underline decoration-text-1" : ""} ${
                isLast && lastSegmentClassName ? lastSegmentClassName : ""
              }`.trim()}
              role={isClickable ? "button" : undefined}
              tabIndex={isClickable ? 0 : undefined}
              onClick={() => handleSegmentClick(segment)}
              onKeyDown={
                isClickable
                  ? (event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      handleSegmentClick(segment);
                    }
                  : undefined
              }
            >
              {segmentIcon ? (
                <span className="mr-1.5 inline-flex shrink-0 items-center text-text-2">
                  {segmentIcon}
                </span>
              ) : null}
              {singleLineTitle ? (
                <span className="min-w-0 flex-1 truncate">
                  {segment.content ?? segment.label}
                </span>
              ) : (
                (segment.content ?? segment.label)
              )}
            </span>

            {!isLast && (
              <ChevronRight
                size={14}
                strokeWidth={1.75}
                className="mx-0 flex-shrink-0 text-fill-4"
                aria-hidden="true"
              />
            )}

            {isActive && !disableNavigation && !segment.isLast && (
              <FileDropdown
                visible={true}
                directoryPath={segment.fullPath}
                repoPath={repoPath}
                currentFilePath={filePath}
                onFileSelect={handleFileSelect}
                onClose={handleCloseDropdown}
                triggerRef={activeTriggerRef}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};

export default BreadcrumbFileHeader;
