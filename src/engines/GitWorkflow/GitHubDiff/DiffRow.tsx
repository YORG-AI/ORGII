/**
 * DiffRow Components
 *
 * Row rendering components for unified and split diff views
 * Inspired by GitHub Desktop's diff rendering
 */
import hljs from "highlight.js";
import { ChevronDown, ChevronRight, Minus, Plus } from "lucide-react";
import React, { useMemo } from "react";

import { createKeyboardActivationHandler } from "@src/util/dom/keyboardActivation";

import type { DiffRowProps, SplitDiffRowProps } from "./types";

// ============================================
// Utility Functions
// ============================================

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const map: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  };
  return text.replace(/[&<>"']/g, (match) => map[match]);
}

/**
 * Highlight a line of code
 */
function highlightLine(content: string, language?: string): string {
  if (!content || !language) {
    return escapeHtml(content || "");
  }

  try {
    const result = hljs.highlight(content, {
      language,
      ignoreIllegals: true,
    });
    return result.value;
  } catch {
    return escapeHtml(content);
  }
}

/**
 * Get CSS class for line type
 */
function getLineTypeClass(type: string): string {
  switch (type) {
    case "add":
      return "diff-row-add";
    case "remove":
      return "diff-row-remove";
    case "context":
      return "diff-row-context";
    case "hunk-header":
      return "diff-row-hunk-header";
    case "empty":
      return "diff-row-empty";
    default:
      return "";
  }
}

// ============================================
// Unified Diff Row Component
// ============================================

export const UnifiedDiffRow: React.FC<DiffRowProps> = React.memo(
  ({ line, language, isHighlighted, onClick, maxLineNumber = 999 }) => {
    const gutterWidth = String(maxLineNumber).length;

    const highlightedContent = useMemo(
      () => highlightLine(line.content, language),
      [line.content, language]
    );

    const icon =
      line.type === "add" ? (
        <Plus size={12} strokeWidth={2.5} />
      ) : line.type === "remove" ? (
        <Minus size={12} strokeWidth={2.5} />
      ) : null;

    return (
      <div
        className={`diff-row ${getLineTypeClass(line.type)} ${isHighlighted ? "diff-row-highlighted" : ""}`}
        onClick={onClick}
      >
        <div
          className="diff-gutter diff-gutter-old"
          style={{ minWidth: gutterWidth * 8 + 16 }}
        >
          {line.oldLineNumber ?? ""}
        </div>
        <div
          className="diff-gutter diff-gutter-new"
          style={{ minWidth: gutterWidth * 8 + 16 }}
        >
          {line.newLineNumber ?? ""}
        </div>
        <div className="diff-indicator">{icon}</div>
        <div className="diff-content">
          <pre
            dangerouslySetInnerHTML={{
              __html: highlightedContent || "&nbsp;",
            }}
          />
        </div>
      </div>
    );
  }
);

UnifiedDiffRow.displayName = "UnifiedDiffRow";

// ============================================
// Split Diff Row Component
// ============================================

export const SplitDiffRowComponent: React.FC<SplitDiffRowProps> = React.memo(
  ({
    row,
    language,
    isHighlighted,
    onLeftClick,
    onRightClick,
    maxLineNumber = 999,
  }) => {
    const gutterWidth = String(maxLineNumber).length;

    const leftHighlighted = useMemo(
      () => highlightLine(row.left.content, language),
      [row.left.content, language]
    );

    const rightHighlighted = useMemo(
      () => highlightLine(row.right.content, language),
      [row.right.content, language]
    );

    // Hunk header row
    if (row.isHunkHeader) {
      return (
        <div className="diff-split-row diff-row-hunk-header">
          <div className="diff-split-cell diff-split-left">
            <div className="diff-hunk-header-content">{row.left.content}</div>
          </div>
          <div className="diff-split-divider" />
          <div className="diff-split-cell diff-split-right">
            <div className="diff-hunk-header-content">{row.right.content}</div>
          </div>
        </div>
      );
    }

    const leftIcon =
      row.left.type === "remove" ? <Minus size={12} strokeWidth={2.5} /> : null;

    const rightIcon =
      row.right.type === "add" ? <Plus size={12} strokeWidth={2.5} /> : null;

    return (
      <div
        className={`diff-split-row ${isHighlighted ? "diff-split-row-highlighted" : ""}`}
      >
        {/* Left side (old file) */}
        <div
          className={`diff-split-cell diff-split-left ${getLineTypeClass(row.left.type)}`}
          onClick={onLeftClick}
        >
          <div
            className="diff-gutter"
            style={{ minWidth: gutterWidth * 8 + 16 }}
          >
            {row.left.lineNumber ?? ""}
          </div>
          <div className="diff-indicator">{leftIcon}</div>
          <div className="diff-content">
            <pre
              dangerouslySetInnerHTML={{
                __html: leftHighlighted || "&nbsp;",
              }}
            />
          </div>
        </div>

        {/* Divider */}
        <div className="diff-split-divider" />

        {/* Right side (new file) */}
        <div
          className={`diff-split-cell diff-split-right ${getLineTypeClass(row.right.type)}`}
          onClick={onRightClick}
        >
          <div
            className="diff-gutter"
            style={{ minWidth: gutterWidth * 8 + 16 }}
          >
            {row.right.lineNumber ?? ""}
          </div>
          <div className="diff-indicator">{rightIcon}</div>
          <div className="diff-content">
            <pre
              dangerouslySetInnerHTML={{
                __html: rightHighlighted || "&nbsp;",
              }}
            />
          </div>
        </div>
      </div>
    );
  }
);

SplitDiffRowComponent.displayName = "SplitDiffRowComponent";

// ============================================
// Collapsed Section Component
// ============================================

interface CollapsedSectionProps {
  lineCount: number;
  isExpanded: boolean;
  onToggle: () => void;
}

export const CollapsedSection: React.FC<CollapsedSectionProps> = React.memo(
  ({ lineCount, isExpanded, onToggle }) => {
    return (
      <div
        className="diff-collapsed-section"
        onClick={onToggle}
        onKeyDown={createKeyboardActivationHandler(onToggle)}
        role="button"
        tabIndex={0}
        aria-expanded={isExpanded}
      >
        <div className="diff-collapsed-icon">
          {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        <span className="diff-collapsed-text">
          {isExpanded ? "Hide" : "Show"} {lineCount} unchanged line
          {lineCount !== 1 ? "s" : ""}
        </span>
      </div>
    );
  }
);

CollapsedSection.displayName = "CollapsedSection";

// ============================================
// Exports
// ============================================

export default UnifiedDiffRow;
