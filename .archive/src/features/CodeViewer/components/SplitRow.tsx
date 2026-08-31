/**
 * SplitRow Component
 *
 * Displays a single row in the split diff view
 * Shows old content on left, new content on right, with line numbers in center
 */
import React from "react";

import { codeMirrorPrismTheme } from "@src/features/CodeMirror/themes/prism";
import {
  Add01Icon,
  HugeiconsIcon,
  MinusSignIcon,
  Tick01Icon,
} from "@src/icons";
import { PrismLight as PrismHighlighter } from "@src/util/language/prismLight";

import type { AlignedLine } from "../types";
import { CherryPickCheckbox } from "./CherryPickCheckbox";

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
  fontSize: "12px",
  fontFamily: CODE_FONT,
  lineHeight: "1.5",
  overflow: "visible",
};

const SYNTAX_CODE_TAG_PROPS = {
  style: { background: "transparent", fontFamily: CODE_FONT },
};

interface SplitRowProps {
  line: AlignedLine;
  language?: string;
  cherrypicking?: boolean;
  // Separate selection state for old (left) and new (right) sides
  isOldSelected?: boolean;
  isNewSelected?: boolean;
  onToggleOldSelection?: () => void;
  onToggleNewSelection?: () => void;
  // Multi-select range props
  isRangeStart?: boolean;
  rangeFullySelected?: boolean;
  rangePartiallySelected?: boolean;
  onToggleRange?: () => void;
}

export const SplitRow = React.memo<SplitRowProps>(
  ({
    line,
    language,
    cherrypicking,
    isOldSelected = false,
    isNewSelected = false,
    onToggleOldSelection,
    onToggleNewSelection,
    isRangeStart = false,
    rangeFullySelected = false,
    rangePartiallySelected = false,
    onToggleRange,
  }) => {
    const oldType = line.oldLine?.type || "empty";
    const newType = line.newLine?.type || "empty";

    const oldContent = line.oldLine?.content || "";
    const newContent = line.newLine?.content || "";

    const oldIcon =
      oldType === "remove" ? (
        <HugeiconsIcon
          icon={MinusSignIcon}
          data-icon="minus"
          size={12}
          strokeWidth={2.5}
        />
      ) : null;
    const newIcon =
      newType === "add" ? (
        <HugeiconsIcon
          icon={Add01Icon}
          data-icon="plus"
          size={12}
          strokeWidth={2.5}
        />
      ) : null;

    const hasChange = oldType === "remove" || newType === "add";

    // Get background class for multi-select column based on state
    const getMultiSelectBgClass = () => {
      if (rangeFullySelected || rangePartiallySelected)
        return "cherry-pick-multi-checked";
      if (oldType === "remove" || newType === "add")
        return "cherry-pick-multi-change";
      return "cherry-pick-multi-context";
    };

    return (
      <div className={`split-row ${hasChange ? "split-row-changed" : ""}`}>
        {/* Left pane - Old content */}
        <div
          className={`split-row-pane split-row-pane-left split-row-${oldType}`}
        >
          <div className="split-row-content">
            {oldContent ? (
              <SyntaxHighlighter
                language={language || "text"}
                style={codeMirrorPrismTheme}
                customStyle={SYNTAX_CUSTOM_STYLE}
                codeTagProps={SYNTAX_CODE_TAG_PROPS}
                wrapLines={false}
                wrapLongLines={false}
                PreTag="span"
                CodeTag="span"
              >
                {oldContent}
              </SyntaxHighlighter>
            ) : (
              <span>&nbsp;</span>
            )}
          </div>
          <div className="split-row-indicator">{oldIcon}</div>
        </div>

        {/* Center gutter with line numbers and cherry-pick columns */}
        <div className="split-row-center">
          {/* Old line number */}
          <div
            className={`split-row-gutter split-row-gutter-old ${oldType !== "empty" ? `gutter-${oldType}` : ""}`}
          >
            {line.oldLine?.number ?? ""}
          </div>

          {/* Cherry-pick columns: [left per-line] [multi-line] [right per-line] */}
          {cherrypicking && (
            <>
              {/* Left per-line checkbox (for old/deletion side) */}
              <div className="split-row-cherrypick split-row-cherrypick-left">
                <CherryPickCheckbox
                  checked={isOldSelected}
                  lineType={
                    oldType === "remove"
                      ? "remove"
                      : oldType === "empty"
                        ? "empty"
                        : "context"
                  }
                  onClick={onToggleOldSelection || (() => {})}
                />
              </div>

              {/* Multi-select column - shows check/minus at range start */}
              <div
                className={`split-row-multiselect ${getMultiSelectBgClass()}`}
                onClick={isRangeStart ? onToggleRange : undefined}
                style={{
                  cursor: isRangeStart
                    ? "var(--interactive-cursor, default)"
                    : "default",
                }}
              >
                {isRangeStart && rangeFullySelected && (
                  <HugeiconsIcon
                    icon={Tick01Icon}
                    data-icon="check"
                    size={14}
                    strokeWidth={2.5}
                  />
                )}
                {isRangeStart &&
                  rangePartiallySelected &&
                  !rangeFullySelected && (
                    <HugeiconsIcon
                      icon={MinusSignIcon}
                      data-icon="minus"
                      size={14}
                      strokeWidth={2.5}
                    />
                  )}
              </div>

              {/* Right per-line checkbox (for new/addition side) */}
              <div className="split-row-cherrypick split-row-cherrypick-right">
                <CherryPickCheckbox
                  checked={isNewSelected}
                  lineType={
                    newType === "add"
                      ? "add"
                      : newType === "empty"
                        ? "empty"
                        : "context"
                  }
                  onClick={onToggleNewSelection || (() => {})}
                />
              </div>
            </>
          )}

          {/* New line number */}
          <div
            className={`split-row-gutter split-row-gutter-new ${newType !== "empty" ? `gutter-${newType}` : ""}`}
          >
            {line.newLine?.number ?? ""}
          </div>
        </div>

        {/* Right pane - New content */}
        <div
          className={`split-row-pane split-row-pane-right split-row-${newType}`}
        >
          <div className="split-row-indicator">{newIcon}</div>
          <div className="split-row-content">
            {newContent ? (
              <SyntaxHighlighter
                language={language || "text"}
                style={codeMirrorPrismTheme}
                customStyle={SYNTAX_CUSTOM_STYLE}
                codeTagProps={SYNTAX_CODE_TAG_PROPS}
                wrapLines={false}
                wrapLongLines={false}
                PreTag="span"
                CodeTag="span"
              >
                {newContent}
              </SyntaxHighlighter>
            ) : (
              <span>&nbsp;</span>
            )}
          </div>
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
      prevProps.isOldSelected === nextProps.isOldSelected &&
      prevProps.isNewSelected === nextProps.isNewSelected &&
      prevProps.isRangeStart === nextProps.isRangeStart &&
      prevProps.rangeFullySelected === nextProps.rangeFullySelected &&
      prevProps.rangePartiallySelected === nextProps.rangePartiallySelected
    );
  }
);

SplitRow.displayName = "SplitRow";
