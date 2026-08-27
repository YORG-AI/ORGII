/**
 * VirtualizedModernDiff Component
 *
 * High-performance virtualized diff viewer that only renders visible lines.
 * Handles large diffs (10,000+ lines) smoothly by using react-virtuoso.
 *
 * Features:
 * - Renders only visible lines (constant memory usage)
 * - Smooth scrolling for any file size
 * - All features from ModernDiff (cherry-picking, syntax highlighting, etc.)
 */
import { Check } from "lucide-react";
import React, { useCallback, useRef } from "react";
import { Components, Virtuoso, VirtuosoHandle } from "react-virtuoso";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import { Placeholder } from "@src/components/Placeholder";

import { DiffLineComponent } from "./DiffLineComponent";
import "./index.scss";
import type { ModernDiffProps } from "./types";
import { useCherryPickSelection } from "./useCherryPickSelection";
import { useDiffLines } from "./useDiffLines";

// Custom Virtuoso List component to ensure all rows have consistent width
const VirtuosoList = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ style, children, ...props }, ref) => (
  <div
    ref={ref}
    style={{
      ...style,
      display: "inline-block",
      minWidth: "100%",
    }}
    {...props}
  >
    {children}
  </div>
));
VirtuosoList.displayName = "VirtuosoList";

// Virtuoso components configuration
const virtuosoComponents: Components = {
  List: VirtuosoList,
};

// ============================================
// Main Virtualized Component
// ============================================

const VirtualizedModernDiffComponent: React.FC<ModernDiffProps> = ({
  oldValue,
  newValue,
  filePath,
  height = "100%",
  width = "100%",
  contextLines = 3,
  collapseUnchanged = true,
  showFilePath = true,
  showStatsBar = true,
  noWrapper = false,
  cherrypicking = false,
  onSelectionChange,
  initialSelection,
  showLineNumbers = true,
  internalScroll = true,
  allowExpand = true,
  indicatorStyle = "icon",
  oldStartLine = 1,
  newStartLine = 1,
  className,
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Diff computation, language detection, expansion, and flattening
  const {
    isComputing,
    diffLines,
    flattenedLines,
    collapseIndexMap,
    language,
    stats,
    handleExpand,
  } = useDiffLines({
    oldValue,
    newValue,
    filePath,
    contextLines,
    collapseUnchanged,
    oldStartLine,
    newStartLine,
  });

  // Cherry-pick selection state and callbacks
  const {
    selectedLines,
    toggleLineSelection,
    toggleRangeSelection,
    isRangeSelected,
    toggleAllSelection,
    allSelected,
    lineToRange,
  } = useCherryPickSelection({
    diffLines,
    cherrypicking,
    initialSelection,
    onSelectionChange,
  });

  // Row renderer for virtuoso
  const renderRow = useCallback(
    (index: number) => {
      const line = flattenedLines[index];
      if (!line) return null;

      // Collapse ordinal for this row (only meaningful for `collapse` rows).
      // Precomputed once in useDiffLines; previously this was an O(index) scan
      // re-run for every visible row on every render and scroll frame.
      const collapseIndex = collapseIndexMap.get(index) ?? 0;

      const range =
        line.index !== undefined ? lineToRange.get(line.index) : undefined;
      const isRangeStart = range ? range.startIndex === line.index : false;
      const rangeSelectedVal = range ? isRangeSelected(range) : false;
      const isSingleLine = range ? range.lineIndices.length === 1 : false;

      return (
        <DiffLineComponent
          line={line}
          language={language}
          onExpand={
            line.type === "collapse"
              ? () => handleExpand(collapseIndex)
              : undefined
          }
          cherrypicking={cherrypicking}
          isSelected={line.index !== undefined && selectedLines.has(line.index)}
          onToggleSelection={
            line.index !== undefined
              ? () => toggleLineSelection(line.index!)
              : undefined
          }
          isRangeStart={isRangeStart}
          rangeSelected={rangeSelectedVal}
          onToggleRange={range ? () => toggleRangeSelection(range) : undefined}
          isSingleLineRange={isSingleLine}
          showLineNumbers={showLineNumbers}
          allowExpand={allowExpand}
          indicatorStyle={indicatorStyle}
        />
      );
    },
    [
      flattenedLines,
      collapseIndexMap,
      language,
      cherrypicking,
      selectedLines,
      toggleLineSelection,
      lineToRange,
      isRangeSelected,
      toggleRangeSelection,
      handleExpand,
      showLineNumbers,
      allowExpand,
      indicatorStyle,
    ]
  );

  const rootClassName = [
    noWrapper ? "modern-diff-no-wrapper" : "modern-diff",
    cherrypicking ? "modern-diff-cherrypicking" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  // Calculate container height
  const containerHeight =
    typeof height === "number" ? height : height === "100%" ? "100%" : height;

  // Show loading state while computing
  if (isComputing || diffLines.length === 0) {
    return (
      <div
        className={rootClassName}
        style={{
          height: containerHeight,
          width: typeof width === "number" ? `${width}px` : width,
        }}
      >
        {showStatsBar && (
          <div className="modern-diff-stats">
            <div className="stats-left">
              {showFilePath && filePath && (
                <span className="stats-path">{filePath}</span>
              )}
            </div>
          </div>
        )}
        <div
          className="modern-diff-content"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
          }}
        >
          <Placeholder variant="loading" title="Computing diff..." />
        </div>
      </div>
    );
  }

  return (
    <div
      className={rootClassName}
      style={{
        height: internalScroll ? containerHeight : "auto",
        width: typeof width === "number" ? `${width}px` : width,
        // When noWrapper is true, parent handles scrolling - don't add overflow here
        ...(noWrapper
          ? {}
          : { overflowX: internalScroll ? undefined : "auto" }),
      }}
    >
      {/* Stats bar */}
      {showStatsBar && (
        <div className="modern-diff-stats">
          <div className="stats-left">
            {cherrypicking && (
              <div
                className={`diff-cherry-pick-all ${allSelected ? "diff-cherry-pick-all-checked" : ""}`}
                onClick={toggleAllSelection}
                title={
                  allSelected ? "Deselect all changes" : "Select all changes"
                }
              >
                {allSelected && <Check size={12} strokeWidth={3} />}
              </div>
            )}
            {showFilePath && filePath && (
              <span className="stats-path">{filePath}</span>
            )}
          </div>
          <DiffStatsBadge
            additions={stats.additions}
            deletions={stats.deletions}
            variant="plain"
            className="stats-right"
          />
        </div>
      )}

      {/* Diff content */}
      <div
        className="modern-diff-content"
        style={{
          height: internalScroll ? "100%" : "auto",
        }}
      >
        {internalScroll ? (
          <Virtuoso
            ref={virtuosoRef}
            totalCount={flattenedLines.length}
            itemContent={renderRow}
            overscan={200}
            increaseViewportBy={{ top: 100, bottom: 200 }}
            computeItemKey={(index) => {
              const line = flattenedLines[index];
              if (!line) return `diff-line-${index}`;

              // Create stable key based on line properties
              // For collapse rows, use collapse index from map
              if (line.type === "collapse") {
                const collapseIdx = collapseIndexMap.get(index);
                return `collapse-${collapseIdx ?? index}`;
              }

              // For regular lines, use a combination of properties that uniquely identify the line
              // This ensures the key stays stable even when sections expand/collapse
              if (line.index !== undefined) {
                return `diff-line-${line.index}`;
              }

              const keyParts = [
                line.type,
                line.oldLineNumber ?? "",
                line.newLineNumber ?? "",
                line.content
                  ? line.content.substring(0, 30).replace(/[^a-zA-Z0-9]/g, "")
                  : "",
              ];
              return `diff-line-${keyParts.join("-")}`;
            }}
            className="virtuoso-no-scrollbar"
            components={virtuosoComponents}
            style={{
              height: "100%",
              scrollbarWidth: "none",
              msOverflowStyle: "none",
            }}
          />
        ) : (
          <div className="modern-diff-static-list">
            {flattenedLines.map((_, index) => (
              <div key={`diff-line-${index}`}>{renderRow(index)}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================
// Export
// ============================================

export const VirtualizedModernDiff = React.memo(VirtualizedModernDiffComponent);
VirtualizedModernDiff.displayName = "VirtualizedModernDiff";

export default VirtualizedModernDiff;
