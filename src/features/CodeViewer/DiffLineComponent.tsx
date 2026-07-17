/**
 * DiffLineComponent - Renders individual diff lines with syntax highlighting.
 * Extracted from VirtualizedModernDiff for reuse and file size management.
 */
import {
  ArrowDownFromLine,
  ArrowUpFromLine,
  Check,
  FoldVertical,
  Minus,
  Plus,
} from "lucide-react";
import React from "react";
import { Prism as PrismHighlighter } from "react-syntax-highlighter";

import { codeMirrorPrismTheme } from "@src/features/CodeMirror/themes/prism";

import type { DiffLine } from "./types";

/** Properly typed SyntaxHighlighter props for our usage */
interface SyntaxHighlighterProps {
  language: string;
  style: Record<string, React.CSSProperties>;
  customStyle?: React.CSSProperties;
  children: string;
  codeTagProps?: { style?: React.CSSProperties };
  PreTag?: string;
  CodeTag?: string;
  showLineNumbers?: boolean;
  wrapLines?: boolean;
  wrapLongLines?: boolean;
  className?: string;
}

const SyntaxHighlighter =
  PrismHighlighter as unknown as React.FC<SyntaxHighlighterProps>;

// Code font family - uses CSS variable for user-configurable font
const CODE_FONT = "var(--cm-font-family)";

// Pre-defined style objects to avoid re-creating on every render
const SYNTAX_CUSTOM_STYLE: React.CSSProperties = {
  background: "transparent",
  backgroundColor: "transparent",
  margin: 0,
  padding: 0,
  overflow: "visible",
  fontFamily: CODE_FONT,
  fontSize: "12px",
  lineHeight: "1.5",
};

const SYNTAX_CODE_TAG_PROPS = {
  style: {
    background: "transparent",
    backgroundColor: "transparent",
    fontFamily: CODE_FONT,
  },
};

// ============================================
// Cherry Pick Checkbox Component
// ============================================

interface CherryPickCheckboxProps {
  checked: boolean;
  lineType: "add" | "remove" | "context" | "collapse";
  onClick: () => void;
}

const CherryPickCheckbox: React.FC<CherryPickCheckboxProps> = ({
  checked,
  lineType,
  onClick,
}) => {
  if (lineType === "context" || lineType === "collapse") {
    return <div className="diff-cherry-pick diff-cherry-pick-empty" />;
  }

  const getUncheckedColor = () => {
    if (lineType === "add") return "diff-cherry-pick-add";
    if (lineType === "remove") return "diff-cherry-pick-remove";
    return "";
  };

  return (
    <div
      className={`diff-cherry-pick ${
        checked ? "diff-cherry-pick-checked" : getUncheckedColor()
      }`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {checked && <Check size={14} strokeWidth={2.5} />}
    </div>
  );
};

// ============================================
// Diff Line Component (Optimized for virtualization)
// ============================================

export interface DiffLineComponentProps {
  line: DiffLine;
  language?: string;
  onExpand?: (lines: DiffLine[]) => void;
  cherrypicking?: boolean;
  isSelected?: boolean;
  onToggleSelection?: () => void;
  isRangeStart?: boolean;
  rangeSelected?: boolean;
  onToggleRange?: () => void;
  isSingleLineRange?: boolean;
  showLineNumbers?: boolean;
  allowExpand?: boolean;
  /** Style for change indicators: "icon" shows +/- icons, "border" shows colored left border */
  indicatorStyle?: "icon" | "border";
}

export const DiffLineComponent = React.memo<DiffLineComponentProps>(
  ({
    line,
    language,
    onExpand,
    cherrypicking,
    isSelected = false,
    onToggleSelection,
    isRangeStart = false,
    rangeSelected = false,
    onToggleRange,
    isSingleLineRange = false,
    showLineNumbers = true,
    allowExpand = true,
    indicatorStyle = "icon",
  }) => {
    const getMultiSelectClass = () => {
      if (rangeSelected) return "diff-cherry-pick-multi-checked";
      if (line.type === "add") return "diff-cherry-pick-multi-add";
      if (line.type === "remove") return "diff-cherry-pick-multi-remove";
      return "diff-cherry-pick-multi-context";
    };

    if (line.type === "collapse") {
      // Determine icon based on collapse position
      const CollapseIcon =
        line.collapsePosition === "start"
          ? ArrowUpFromLine
          : line.collapsePosition === "end"
            ? ArrowDownFromLine
            : FoldVertical;

      const isClickable = allowExpand && onExpand;

      return (
        <div
          className={`diff-line diff-line-collapse${!isClickable ? "diff-line-collapse-disabled" : ""}`}
          onClick={
            isClickable ? () => onExpand(line.collapsedLines || []) : undefined
          }
          style={{ cursor: isClickable ? "pointer" : "default" }}
        >
          {cherrypicking && (
            <>
              <div className="diff-cherry-pick-multi diff-cherry-pick-multi-context" />
              <div className="diff-cherry-pick diff-cherry-pick-empty" />
            </>
          )}
          {showLineNumbers && (
            <>
              <div className="diff-line-gutter diff-gutter-old">
                <CollapseIcon size={14} className="collapse-icon" />
              </div>
              <div className="diff-line-gutter diff-gutter-new" />
            </>
          )}
          <div className="diff-line-content">
            <span className="collapse-label text-primary-6">
              {line.collapsedCount} hidden lines
            </span>
          </div>
        </div>
      );
    }

    const useBorderStyle = indicatorStyle === "border";
    const lineClasses = `diff-line diff-line-${line.type}${useBorderStyle ? " diff-line-border-style" : ""}`;
    const icon =
      line.type === "add" ? (
        <Plus size={12} strokeWidth={2.5} />
      ) : line.type === "remove" ? (
        <Minus size={12} strokeWidth={2.5} />
      ) : null;

    const isChangeLine = line.type === "add" || line.type === "remove";
    const content = line.content || "";

    return (
      <div className={lineClasses}>
        {cherrypicking && (
          <>
            <div
              className={`diff-cherry-pick-multi ${getMultiSelectClass()}`}
              onClick={isRangeStart ? onToggleRange : undefined}
              style={{ cursor: isRangeStart ? "pointer" : "default" }}
            >
              {isRangeStart && rangeSelected && (
                <Check size={14} strokeWidth={2.5} />
              )}
            </div>
            {isSingleLineRange && isChangeLine ? (
              <div
                className={`diff-cherry-pick ${isSelected ? "diff-cherry-pick-checked" : line.type === "add" ? "diff-cherry-pick-add" : "diff-cherry-pick-remove"}`}
              />
            ) : (
              <CherryPickCheckbox
                checked={isSelected}
                lineType={line.type}
                onClick={onToggleSelection || (() => {})}
              />
            )}
          </>
        )}
        {showLineNumbers && (
          <>
            <div className="diff-line-gutter diff-gutter-old">
              {line.oldLineNumber ?? ""}
            </div>
            <div className="diff-line-gutter diff-gutter-new">
              {line.newLineNumber ?? ""}
            </div>
          </>
        )}
        {/* Only show +/- indicator when using icon style */}
        {!useBorderStyle && <div className="diff-line-indicator">{icon}</div>}
        <div className="diff-line-content">
          {content ? (
            <SyntaxHighlighter
              language={language || "text"}
              style={codeMirrorPrismTheme}
              customStyle={SYNTAX_CUSTOM_STYLE}
              codeTagProps={SYNTAX_CODE_TAG_PROPS}
              PreTag="span"
              CodeTag="span"
              wrapLines={false}
              wrapLongLines={false}
              className="diff-syntax-content"
            >
              {content}
            </SyntaxHighlighter>
          ) : (
            <span>&nbsp;</span>
          )}
        </div>
      </div>
    );
  },
  // Custom comparison to prevent unnecessary re-renders
  (prevProps, nextProps) => {
    return (
      prevProps.line === nextProps.line &&
      prevProps.language === nextProps.language &&
      prevProps.cherrypicking === nextProps.cherrypicking &&
      prevProps.isSelected === nextProps.isSelected &&
      prevProps.isRangeStart === nextProps.isRangeStart &&
      prevProps.rangeSelected === nextProps.rangeSelected &&
      prevProps.isSingleLineRange === nextProps.isSingleLineRange &&
      prevProps.showLineNumbers === nextProps.showLineNumbers &&
      prevProps.allowExpand === nextProps.allowExpand &&
      prevProps.indicatorStyle === nextProps.indicatorStyle
    );
  }
);

DiffLineComponent.displayName = "DiffLineComponent";
