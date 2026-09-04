/**
 * JsonTreeView Component
 *
 * Displays JSON content in a collapsible tree structure.
 *
 * Features:
 * - Expand/collapse nodes
 * - Syntax highlighting for different value types
 * - Copy path or value on click
 * - Large file handling with collapse by default
 */
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Message } from "@src/components/Message";
import { Placeholder } from "@src/components/Placeholder";
import i18n from "@src/i18n";
import { ArrowDown01Icon, ArrowRight01Icon, HugeiconsIcon } from "@src/icons";
import { copyText } from "@src/util/data/clipboard";

import "./index.scss";

// ============================================
// Types
// ============================================

interface JsonTreeViewProps {
  /** JSON content as string */
  content: string;
  /** Optional class name */
  className?: string;
}

interface JsonNodeProps {
  keyName: string | null;
  value: unknown;
  path: string;
  depth: number;
  defaultExpanded: boolean;
}

// ============================================
// Constants
// ============================================

// Files larger than this will have nodes collapsed by default
const LARGE_FILE_THRESHOLD = 100 * 1024; // 100KB
// Maximum depth for default expansion
const MAX_DEFAULT_EXPAND_DEPTH = 2;
// Maximum items to show before virtualization hint
const MAX_ARRAY_PREVIEW = 100;

// ============================================
// Helper Functions
// ============================================

/**
 * Format a preview of array/object for collapsed state
 */
function getCollapsedPreview(value: unknown): string {
  if (Array.isArray(value)) {
    const len = value.length;
    if (len === 0) return "[]";
    return `[...] (${len} item${len === 1 ? "" : "s"})`;
  }
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value);
    const len = keys.length;
    if (len === 0) return "{}";
    return `{...} (${len} key${len === 1 ? "" : "s"})`;
  }
  return String(value);
}

/**
 * Copy text to clipboard with feedback
 */
async function copyToClipboard(text: string): Promise<void> {
  try {
    await copyText(text);
    Message.success(i18n.t("status.copied"));
  } catch {
    Message.error(i18n.t("errors.failedToCopy"));
  }
}

// ============================================
// Value Renderer
// ============================================

const ValueRenderer: React.FC<{ value: unknown; path: string }> = memo(
  ({ value, path }) => {
    const handleCopy = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        const text =
          typeof value === "string" ? value : JSON.stringify(value, null, 2);
        copyToClipboard(text);
      },
      [value]
    );

    const handleCopyPath = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
        copyToClipboard(path);
      },
      [path]
    );

    const copyTooltip = i18n.t("tooltips.copyValueRightClickForPath");

    if (value === null) {
      return (
        <span
          className="json-value json-value--null"
          onClick={handleCopy}
          onContextMenu={handleCopyPath}
          title={copyTooltip}
        >
          null
        </span>
      );
    }

    if (typeof value === "boolean") {
      return (
        <span
          className="json-value json-value--boolean"
          onClick={handleCopy}
          onContextMenu={handleCopyPath}
          title={copyTooltip}
        >
          {value ? "true" : "false"}
        </span>
      );
    }

    if (typeof value === "number") {
      return (
        <span
          className="json-value json-value--number"
          onClick={handleCopy}
          onContextMenu={handleCopyPath}
          title={copyTooltip}
        >
          {value}
        </span>
      );
    }

    if (typeof value === "string") {
      // Truncate long strings for display
      const displayValue =
        value.length > 500 ? value.slice(0, 500) + "..." : value;
      return (
        <span
          className="json-value json-value--string"
          onClick={handleCopy}
          onContextMenu={handleCopyPath}
          title={copyTooltip}
        >
          &quot;{displayValue}&quot;
        </span>
      );
    }

    return null;
  }
);

ValueRenderer.displayName = "ValueRenderer";

// ============================================
// JSON Node Component
// ============================================

const JsonNode: React.FC<JsonNodeProps> = memo(
  ({ keyName, value, path, depth, defaultExpanded }) => {
    const [expanded, setExpanded] = useState(defaultExpanded);

    const isExpandable =
      (typeof value === "object" && value !== null) || Array.isArray(value);
    const isArray = Array.isArray(value);

    // Handle toggle expand
    const handleToggle = useCallback(() => {
      setExpanded((prev) => !prev);
    }, []);

    // Handle copy path
    const handleCopyPath = useCallback(
      (event: React.MouseEvent) => {
        event.stopPropagation();
        event.preventDefault();
        copyToClipboard(path);
      },
      [path]
    );

    // Render children for objects/arrays
    const children = useMemo(() => {
      if (!expanded || !isExpandable) return null;

      if (isArray) {
        const arr = value as unknown[];
        const displayItems = arr.slice(0, MAX_ARRAY_PREVIEW);
        const hasMore = arr.length > MAX_ARRAY_PREVIEW;

        return (
          <>
            {displayItems.map((item, index) => (
              <JsonNode
                key={index}
                keyName={String(index)}
                value={item}
                path={`${path}[${index}]`}
                depth={depth + 1}
                defaultExpanded={depth + 1 < MAX_DEFAULT_EXPAND_DEPTH}
              />
            ))}
            {hasMore && (
              <div
                className="json-node__more"
                style={{ paddingLeft: `${(depth + 1) * 16 + 20}px` }}
              >
                ... and {arr.length - MAX_ARRAY_PREVIEW} more items
              </div>
            )}
          </>
        );
      }

      // Object
      const obj = value as Record<string, unknown>;
      const entries = Object.entries(obj);

      return entries.map(([key, val]) => {
        const childPath = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key)
          ? `${path}.${key}`
          : `${path}["${key}"]`;

        return (
          <JsonNode
            key={key}
            keyName={key}
            value={val}
            path={childPath}
            depth={depth + 1}
            defaultExpanded={depth + 1 < MAX_DEFAULT_EXPAND_DEPTH}
          />
        );
      });
    }, [expanded, isExpandable, isArray, value, path, depth]);

    // Indent style
    const indentStyle = { paddingLeft: `${depth * 16}px` };

    return (
      <div className="json-node">
        <div
          className={`json-node__row ${isExpandable ? "json-node__row--expandable" : ""}`}
          style={indentStyle}
          onClick={isExpandable ? handleToggle : undefined}
          onContextMenu={handleCopyPath}
        >
          {/* Expand/Collapse icon */}
          {isExpandable ? (
            <span className="json-node__toggle">
              {expanded ? (
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  data-icon="chevron-down"
                  size={14}
                />
              ) : (
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  data-icon="chevron-right"
                  size={14}
                />
              )}
            </span>
          ) : (
            <span className="json-node__toggle-placeholder" />
          )}

          {/* Key name */}
          {keyName !== null && (
            <>
              <span className="json-key">{keyName}</span>
              <span className="json-colon">: </span>
            </>
          )}

          {/* Value or collapsed preview */}
          {isExpandable ? (
            <>
              <span className="json-bracket">{isArray ? "[" : "{"}</span>
              {!expanded && (
                <span className="json-preview">
                  {getCollapsedPreview(value)}
                </span>
              )}
            </>
          ) : (
            <ValueRenderer value={value} path={path} />
          )}
        </div>

        {/* Children */}
        {expanded && children}

        {/* Closing bracket */}
        {expanded && isExpandable && (
          <div className="json-node__row" style={indentStyle}>
            <span className="json-node__toggle-placeholder" />
            <span className="json-bracket">{isArray ? "]" : "}"}</span>
          </div>
        )}
      </div>
    );
  }
);

JsonNode.displayName = "JsonNode";

// ============================================
// Main Component
// ============================================

export const JsonTreeView: React.FC<JsonTreeViewProps> = ({
  content,
  className = "",
}) => {
  const { t } = useTranslation();

  // Parse JSON content - derive as computed value instead of effect + state
  const { parsedData, parseError } = useMemo(() => {
    try {
      const data = JSON.parse(content);
      return { parsedData: data, parseError: null };
    } catch (err) {
      return {
        parsedData: null,
        parseError:
          err instanceof Error ? err.message : t("placeholders.invalidJson"),
      };
    }
  }, [content, t]);

  // Determine if large file (should collapse by default)
  const isLargeFile = content.length > LARGE_FILE_THRESHOLD;

  // Error state
  if (parseError) {
    return (
      <Placeholder
        variant="error"
        placement="detail-panel"
        title={t("placeholders.invalidJson")}
        subtitle={parseError}
        fillParentHeight
        className={className}
      />
    );
  }

  return (
    <div className={`json-tree-view flex h-full flex-col ${className}`}>
      {/* Tree content */}
      <div className="json-tree-view__content flex-1 overflow-auto p-3">
        <JsonNode
          keyName={null}
          value={parsedData}
          path="$"
          depth={0}
          defaultExpanded={!isLargeFile}
        />
      </div>
    </div>
  );
};

export default JsonTreeView;
