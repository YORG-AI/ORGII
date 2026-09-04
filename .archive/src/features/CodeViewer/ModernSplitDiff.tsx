/**
 * ModernSplitDiff Component
 *
 * A beautiful side-by-side diff viewer with synchronized scrolling
 * Features:
 * - Clean, minimal split view design
 * - Line numbers in the middle
 * - Optional cherry-picking support for selecting lines
 * - Single shared scrollbar for both panes
 * - Syntax highlighting
 */
// Syntax highlighting is handled by react-syntax-highlighter in SplitRow
import React, { useRef } from "react";

import DiffStatsBadge from "@src/components/DiffStatsBadge";
import { HugeiconsIcon, Tick01Icon } from "@src/icons";

import "./ModernSplitDiff.scss";
import { CollapseRow } from "./components/CollapseRow";
import { SplitRow } from "./components/SplitRow";
import { useModernSplitDiff } from "./hooks/useModernSplitDiff";
import type { AlignedLine, ModernSplitDiffProps } from "./types";

const ModernSplitDiffComponent: React.FC<ModernSplitDiffProps> = ({
  oldValue,
  newValue,
  filePath,
  height = "100%",
  width = "100%",
  noWrapper = false,
  cherrypicking = false,
  onSelectionChange,
  initialSelection: _initialSelection,
  contextLines = 3,
  collapseUnchanged = true,
}) => {
  const contentRef = useRef<HTMLDivElement>(null);

  // Use hook for all business logic
  const {
    language,
    isPending,
    displayLines,
    stats,
    selectedOldLines,
    selectedNewLines,
    allSelected,
    expandedSections,
    lineToRange,
    toggleOldSelection,
    toggleNewSelection,
    toggleRangeSelection,
    toggleAllSelection,
    handleExpand,
    isRangeFullySelected,
    isRangePartiallySelected,
  } = useModernSplitDiff({
    oldValue,
    newValue,
    filePath,
    cherrypicking,
    onSelectionChange,
    contextLines,
    collapseUnchanged,
  });

  return (
    <div
      className={`modern-split-diff ${noWrapper ? "modern-split-diff-no-wrapper" : ""} ${cherrypicking ? "modern-split-diff-cherrypicking" : ""}`}
      style={{
        height: typeof height === "number" ? `${height}px` : height,
        width: typeof width === "number" ? `${width}px` : width,
        opacity: isPending ? 0.7 : 1,
        transition: "opacity 0.1s ease",
      }}
    >
      {/* Header */}
      {!noWrapper && (
        <div className="split-diff-header">
          <div className="split-diff-header-left">
            <span className="header-label">Original</span>
            <DiffStatsBadge
              deletions={stats.deletions}
              variant="plain"
              size="xs"
              className="header-stats"
              showAdditions={false}
            />
          </div>
          <div className="split-diff-header-center">
            {cherrypicking && (
              <div
                className={`cherry-pick-all ${allSelected ? "cherry-pick-all-checked" : ""}`}
                onClick={toggleAllSelection}
                title={
                  allSelected ? "Deselect all changes" : "Select all changes"
                }
              >
                {allSelected && (
                  <HugeiconsIcon
                    icon={Tick01Icon}
                    data-icon="check"
                    size={12}
                    strokeWidth={3}
                  />
                )}
              </div>
            )}
          </div>
          <div className="split-diff-header-right">
            <span className="header-label">Modified</span>
            <DiffStatsBadge
              additions={stats.additions}
              variant="plain"
              size="xs"
              className="header-stats"
              showDeletions={false}
            />
          </div>
        </div>
      )}

      {/* Content - Single scrollable container */}
      <div className="split-diff-content" ref={contentRef}>
        <div className="split-diff-rows">
          {displayLines.map((item, idx) => {
            // Handle collapsed sections
            if ("type" in item && item.type === "collapse") {
              // Skip if this section is expanded
              if (expandedSections.has(idx)) {
                return item.collapsedLines.map((line: AlignedLine) => {
                  const range = lineToRange.get(line.index);
                  const isRangeStart = range
                    ? range.startIndex === line.index
                    : false;
                  const rangeFullySelected = range
                    ? isRangeFullySelected(range)
                    : false;
                  const rangePartiallySelected = range
                    ? isRangePartiallySelected(range)
                    : false;

                  return (
                    <SplitRow
                      key={line.index}
                      line={line}
                      language={language}
                      cherrypicking={cherrypicking}
                      isOldSelected={selectedOldLines.has(line.index)}
                      isNewSelected={selectedNewLines.has(line.index)}
                      onToggleOldSelection={() =>
                        toggleOldSelection(line.index)
                      }
                      onToggleNewSelection={() =>
                        toggleNewSelection(line.index)
                      }
                      isRangeStart={isRangeStart}
                      rangeFullySelected={rangeFullySelected}
                      rangePartiallySelected={rangePartiallySelected}
                      onToggleRange={
                        range ? () => toggleRangeSelection(range) : undefined
                      }
                    />
                  );
                });
              }

              // Show collapse row
              return (
                <CollapseRow
                  key={`collapse-${idx}`}
                  collapsedSection={item}
                  onExpand={() => handleExpand(idx)}
                  cherrypicking={cherrypicking}
                />
              );
            }

            // Handle regular lines
            const line = item as AlignedLine;
            const range = lineToRange.get(line.index);
            const isRangeStart = range
              ? range.startIndex === line.index
              : false;
            const rangeFullySelected = range
              ? isRangeFullySelected(range)
              : false;
            const rangePartiallySelected = range
              ? isRangePartiallySelected(range)
              : false;

            return (
              <SplitRow
                key={line.index}
                line={line}
                language={language}
                cherrypicking={cherrypicking}
                isOldSelected={selectedOldLines.has(line.index)}
                isNewSelected={selectedNewLines.has(line.index)}
                onToggleOldSelection={() => toggleOldSelection(line.index)}
                onToggleNewSelection={() => toggleNewSelection(line.index)}
                isRangeStart={isRangeStart}
                rangeFullySelected={rangeFullySelected}
                rangePartiallySelected={rangePartiallySelected}
                onToggleRange={
                  range ? () => toggleRangeSelection(range) : undefined
                }
              />
            );
          })}
        </div>
      </div>
    </div>
  );
};

export const ModernSplitDiff = React.memo(ModernSplitDiffComponent);
ModernSplitDiff.displayName = "ModernSplitDiff";

export default ModernSplitDiff;
