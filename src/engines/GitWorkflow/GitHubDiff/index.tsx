/**
 * GitHubDiff Component
 *
 * A professional diff viewer for unified and split file changes.
 *
 * Features:
 * - Unified and Split view modes
 * - Syntax highlighting via highlight.js
 * - Hunk-based rendering with headers
 * - Collapsible unchanged sections
 * - Virtualized rendering for large files
 * - Synchronized scrolling in split view
 */
import "highlight.js/styles/github-dark.css";
import React, {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
} from "react";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import { getLanguageFromPath } from "@src/config/languageMap";

import { SplitDiffRowComponent, UnifiedDiffRow } from "./DiffRow";
import { DEFAULT_PROPS } from "./config";
import "./index.scss";
import type { DiffHunk, DiffLine, GitHubDiffProps } from "./types";
import { useDiff } from "./useDiff";

// ============================================
// Main Component
// ============================================

const GitHubDiffComponent: React.FC<GitHubDiffProps> = ({
  oldValue,
  newValue,
  filePath,
  height = "100%",
  width = "100%",
  viewMode = DEFAULT_PROPS.viewMode,
  contextLines = DEFAULT_PROPS.contextLines,
  syntaxHighlighting = DEFAULT_PROPS.syntaxHighlighting,
  readOnly = DEFAULT_PROPS.readOnly,
  hideWhitespaceChanges = DEFAULT_PROPS.hideWhitespaceChanges,
  showHunkHeaders = DEFAULT_PROPS.showHunkHeaders,
  onLineClick,
  className = "",
}) => {
  // Refs for synchronized scrolling in split view
  const leftPaneRef = useRef<HTMLDivElement>(null);
  const rightPaneRef = useRef<HTMLDivElement>(null);
  const isSyncing = useRef(false);

  // Use deferred values for smooth transitions
  const deferredOldValue = useDeferredValue(oldValue);
  const deferredNewValue = useDeferredValue(newValue);
  const isPending =
    deferredOldValue !== oldValue || deferredNewValue !== newValue;

  // Compute diff using hook
  const { diff, splitRows, stats } = useDiff({
    oldValue: deferredOldValue,
    newValue: deferredNewValue,
    contextLines,
    hideWhitespace: hideWhitespaceChanges,
  });

  // Detect language for syntax highlighting
  const language = useMemo(
    () => (syntaxHighlighting ? getLanguageFromPath(filePath) : undefined),
    [filePath, syntaxHighlighting]
  );

  // Handle synchronized scrolling
  const handleScroll = useCallback((source: "left" | "right") => {
    if (isSyncing.current) return;

    const sourceRef = source === "left" ? leftPaneRef : rightPaneRef;
    const targetRef = source === "left" ? rightPaneRef : leftPaneRef;

    if (sourceRef.current && targetRef.current) {
      isSyncing.current = true;
      targetRef.current.scrollTop = sourceRef.current.scrollTop;
      requestAnimationFrame(() => {
        isSyncing.current = false;
      });
    }
  }, []);

  // Set up scroll listeners for split view
  useEffect(() => {
    if (viewMode !== "split") return;

    const leftEl = leftPaneRef.current;
    const rightEl = rightPaneRef.current;

    const handleLeftScroll = () => handleScroll("left");
    const handleRightScroll = () => handleScroll("right");

    leftEl?.addEventListener("scroll", handleLeftScroll, { passive: true });
    rightEl?.addEventListener("scroll", handleRightScroll, { passive: true });

    return () => {
      leftEl?.removeEventListener("scroll", handleLeftScroll);
      rightEl?.removeEventListener("scroll", handleRightScroll);
    };
  }, [viewMode, handleScroll]);

  // Handle line click
  const handleLineClick = useCallback(
    (line: DiffLine, hunkIndex: number) => {
      if (readOnly) return;
      onLineClick?.(line, hunkIndex);
    },
    [readOnly, onLineClick]
  );

  // Render hunk header
  const renderHunkHeader = useCallback((hunk: DiffHunk) => {
    const headerText = `@@ -${hunk.header.oldStartLine},${hunk.header.oldLineCount} +${hunk.header.newStartLine},${hunk.header.newLineCount} @@`;

    return (
      <div key={`hunk-header-${hunk.hunkIndex}`} className="diff-hunk-header">
        <span className="diff-hunk-header-text">{headerText}</span>
        {hunk.header.sectionHeading && (
          <span className="diff-hunk-header-section">
            {hunk.header.sectionHeading}
          </span>
        )}
      </div>
    );
  }, []);

  // Render unified diff view
  const renderUnifiedView = useMemo(() => {
    if (!diff || diff.hunks.length === 0) {
      return (
        <div className="diff-empty">
          <span>No changes</span>
        </div>
      );
    }

    const elements: React.ReactNode[] = [];

    diff.hunks.forEach((hunk) => {
      // Add hunk header
      if (showHunkHeaders) {
        elements.push(renderHunkHeader(hunk));
      }

      // Add lines
      hunk.lines.forEach((line, lineIdx) => {
        elements.push(
          <UnifiedDiffRow
            key={`${hunk.hunkIndex}-${lineIdx}`}
            line={line}
            language={language}
            maxLineNumber={diff.maxLineNumber}
            onClick={() => handleLineClick(line, hunk.hunkIndex)}
          />
        );
      });
    });

    return elements;
  }, [diff, language, showHunkHeaders, renderHunkHeader, handleLineClick]);

  // Render split diff view
  const renderSplitView = useMemo(() => {
    if (splitRows.length === 0) {
      return (
        <div className="diff-empty">
          <span>No changes</span>
        </div>
      );
    }

    return splitRows.map((row) => (
      <SplitDiffRowComponent
        key={row.key}
        row={row}
        language={language}
        maxLineNumber={diff?.maxLineNumber}
      />
    ));
  }, [splitRows, language, diff?.maxLineNumber]);

  return (
    <div
      className={`github-diff ${viewMode === "split" ? "github-diff-split" : "github-diff-unified"} ${className}`}
      style={{
        height: typeof height === "number" ? `${height}px` : height,
        width: typeof width === "number" ? `${width}px` : width,
        opacity: isPending ? 0.7 : 1,
        transition: "opacity 0.15s ease",
      }}
    >
      {/* Stats Header */}
      <div className="github-diff-header">
        <div className="github-diff-stats">
          <DiffStatsBadge
            additions={stats.additions}
            deletions={stats.deletions}
            variant="plain"
            size="sm"
            className="github-diff-stat"
          />
          {stats.totalChanges === 0 && (
            <span className="github-diff-stat github-diff-stat-empty">
              No changes
            </span>
          )}
        </div>
      </div>

      {/* Diff Content */}
      <div className="github-diff-content">
        {viewMode === "split" ? (
          <div className="github-diff-split-container">{renderSplitView}</div>
        ) : (
          <div className="github-diff-unified-container">
            {renderUnifiedView}
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================
// Export
// ============================================

export const GitHubDiff = React.memo(GitHubDiffComponent);
GitHubDiff.displayName = "GitHubDiff";

export default GitHubDiff;

// Re-export types
export * from "./types";
