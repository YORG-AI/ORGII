/**
 * ModernCodeViewer Component
 *
 * A code viewer component with the same visual style as VirtualizedModernDiff.
 * Uses Prism for syntax highlighting with consistent styling.
 *
 * Features:
 * - Same visual style as diff viewer
 * - Optional line numbers
 * - Optional internal scrolling
 * - Virtualization for large files
 */
import React, { useMemo } from "react";
import { Components, Virtuoso } from "react-virtuoso";

import { getLanguageFromPath } from "@src/config/languageMap";
import { codeMirrorPrismTheme } from "@src/features/CodeMirror/themes/prism";
import { getLanguageFromFilePath } from "@src/util/editor/extension";
import { PrismLight as PrismHighlighter } from "@src/util/language/prismLight";

import "./index.scss";

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
const CODE_FONT = "var(--code-font-family)";

// Custom Virtuoso List component
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

const virtuosoComponents: Components = {
  List: VirtuosoList,
};

// Custom syntax styles - use CSS variable for font size
const SYNTAX_CUSTOM_STYLE: React.CSSProperties = {
  margin: 0,
  padding: 0,
  background: "transparent",
  fontSize: "var(--chat-code-font-size, 13px)",
  lineHeight: "1.5",
  fontFamily: CODE_FONT,
  whiteSpace: "pre",
  display: "inline",
};

const SYNTAX_CODE_TAG_PROPS = {
  style: {
    fontFamily: CODE_FONT,
    fontSize: "var(--chat-code-font-size, 13px)",
    lineHeight: "1.5",
  },
};

// ============================================
// Types
// ============================================

export interface ModernCodeViewerProps {
  /** Code content to display */
  content: string;
  /** Programming language for syntax highlighting */
  language?: string;
  /** File path for language detection */
  filePath?: string;
  /** Container height */
  height?: number | string;
  /** Container width */
  width?: number | string;
  /** Show line numbers (default: true) */
  showLineNumbers?: boolean;
  /** Starting line number (default: 1) */
  startingLineNumber?: number;
  /** Enable internal scrolling (default: true) */
  internalScroll?: boolean;
  /** Disable wrapper styling */
  noWrapper?: boolean;
  /** Remove gutter/content vertical separator (line list) */
  plainLineGutter?: boolean;
  /** Custom class name */
  className?: string;
}

// ============================================
// Line Component
// ============================================

interface CodeLineProps {
  lineNumber: number;
  content: string;
  language?: string;
  showLineNumbers?: boolean;
  /** When true, no vertical separator between gutter and code (matches flat panels). */
  plainGutter?: boolean;
}

const CodeLine = React.memo<CodeLineProps>(
  ({
    lineNumber,
    content,
    language,
    showLineNumbers = true,
    plainGutter = false,
  }) => {
    return (
      <div className="code-line">
        {showLineNumbers && (
          <div
            className={`code-line-gutter${plainGutter ? "code-line-gutter--plain" : ""}`}
          >
            {lineNumber}
          </div>
        )}
        <div className="code-line-content">
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
              className="code-syntax-content"
            >
              {content}
            </SyntaxHighlighter>
          ) : (
            <span>&nbsp;</span>
          )}
        </div>
      </div>
    );
  }
);

CodeLine.displayName = "CodeLine";

// ============================================
// Main Component
// ============================================

export const ModernCodeViewer: React.FC<ModernCodeViewerProps> = ({
  content,
  language,
  filePath,
  height = "100%",
  width = "100%",
  showLineNumbers = true,
  startingLineNumber = 1,
  internalScroll = true,
  noWrapper = false,
  plainLineGutter = false,
  className = "",
}) => {
  // Detect language
  const detectedLanguage = useMemo(() => {
    if (language) return language;
    if (filePath) {
      return getLanguageFromFilePath(filePath) || getLanguageFromPath(filePath);
    }
    return "text";
  }, [language, filePath]);

  // Split content into lines
  const lines = useMemo(() => {
    return (content || "").split("\n");
  }, [content]);

  // Compute container height
  const containerHeight = useMemo(() => {
    if (typeof height === "number") return `${height}px`;
    return height;
  }, [height]);

  // Render a single line
  const renderRow = (index: number) => (
    <CodeLine
      lineNumber={startingLineNumber + index}
      content={lines[index]}
      language={detectedLanguage}
      showLineNumbers={showLineNumbers}
      plainGutter={plainLineGutter}
    />
  );

  if (!content) {
    return null;
  }

  return (
    <div
      className={`${noWrapper ? "modern-code-viewer-no-wrapper" : "modern-code-viewer"} ${className}`}
      style={{
        height: internalScroll ? containerHeight : "auto",
        width: typeof width === "number" ? `${width}px` : width,
        // When noWrapper is true, parent handles scrolling - don't add overflow here
        ...(noWrapper
          ? {}
          : { overflowX: internalScroll ? undefined : "auto" }),
      }}
    >
      <div
        className="modern-code-viewer-content"
        style={{
          height: internalScroll ? "100%" : "auto",
          // Let parent handle scrolling - no overflow here
        }}
      >
        {internalScroll ? (
          <Virtuoso
            totalCount={lines.length}
            itemContent={renderRow}
            overscan={200}
            increaseViewportBy={{ top: 100, bottom: 200 }}
            computeItemKey={(index) => `code-line-${index}`}
            className="virtuoso-no-scrollbar"
            components={virtuosoComponents}
            style={{
              height: "100%",
              scrollbarWidth: "none",
              msOverflowStyle: "none",
            }}
          />
        ) : (
          <div className="modern-code-viewer-static-list">
            {lines.map((_, index) => (
              <div key={`code-line-${index}`}>{renderRow(index)}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

ModernCodeViewer.displayName = "ModernCodeViewer";

export default ModernCodeViewer;
