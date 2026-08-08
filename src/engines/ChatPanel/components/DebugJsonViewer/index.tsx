/**
 * Collapsible JSON tree for inline panels (e.g. Trajectory JSON view).
 */
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import React, { memo, useCallback, useMemo, useState } from "react";

import { createKeyboardActivationHandler } from "@src/util/dom/keyboardActivation";

import "./index.scss";

// ============================================
// JSON Node Component
// ============================================

interface JsonNodeProps {
  keyName: string | number | null;
  value: unknown;
  depth: number;
  defaultExpanded?: boolean;
}

const JsonNode: React.FC<JsonNodeProps> = memo(
  ({ keyName, value, depth, defaultExpanded = false }) => {
    const [isExpanded, setIsExpanded] = useState(defaultExpanded || depth < 2);

    const valueType = useMemo(() => {
      if (value === null) return "null";
      if (Array.isArray(value)) return "array";
      return typeof value;
    }, [value]);

    const isExpandable = valueType === "object" || valueType === "array";

    const toggleExpand = useCallback(() => {
      if (isExpandable) {
        setIsExpanded((prev) => !prev);
      }
    }, [isExpandable]);

    const handleToggleKeyDown = useMemo(
      () => createKeyboardActivationHandler(toggleExpand),
      [toggleExpand]
    );

    // Only expandable rows are interactive; primitive rows stay inert.
    const interactiveRowProps = isExpandable
      ? {
          role: "button" as const,
          tabIndex: 0,
          "aria-expanded": isExpanded,
          onKeyDown: handleToggleKeyDown,
        }
      : {};

    // Render primitive value
    const renderValue = () => {
      switch (valueType) {
        case "string": {
          const strVal = value as string;
          const displayStr =
            strVal.length > 200 ? strVal.slice(0, 200) + "..." : strVal;
          return (
            <span className="json-value json-string">
              &quot;{displayStr}&quot;
            </span>
          );
        }
        case "number":
          return (
            <span className="json-value json-number">{String(value)}</span>
          );
        case "boolean":
          return (
            <span className="json-value json-boolean">{String(value)}</span>
          );
        case "null":
          return <span className="json-value json-null">null</span>;
        case "undefined":
          return <span className="json-value json-undefined">undefined</span>;
        case "array":
          return (
            <span className="json-value json-bracket">
              [{(value as unknown[]).length}]
            </span>
          );
        case "object":
          return (
            <span className="json-value json-bracket">
              {"{"}
              {Object.keys(value as object).length}
              {"}"}
            </span>
          );
        default:
          return <span className="json-value">{String(value)}</span>;
      }
    };

    // Render children for objects/arrays
    const renderChildren = () => {
      if (!isExpandable || !isExpanded) return null;

      const entries =
        valueType === "array"
          ? (value as unknown[]).map((item, index) => [index, item] as const)
          : Object.entries(value as object);

      return (
        <div className="json-children">
          {entries.map(([entryKey, entryValue]) => (
            <JsonNode
              key={String(entryKey)}
              keyName={entryKey}
              value={entryValue}
              depth={depth + 1}
            />
          ))}
        </div>
      );
    };

    return (
      <div className="json-node" style={{ paddingLeft: depth * 16 }}>
        <div
          className="json-node__row"
          onClick={isExpandable ? toggleExpand : undefined}
          {...interactiveRowProps}
        >
          {/* Expand/Collapse Arrow */}
          {isExpandable &&
            (isExpanded ? (
              <ChevronsDownUp size={16} className="json-node__arrow" />
            ) : (
              <ChevronsUpDown size={16} className="json-node__arrow" />
            ))}
          {!isExpandable && <span className="json-node__arrow-placeholder" />}

          {/* Key */}
          {keyName !== null && (
            <>
              <span className="json-key">{String(keyName)}</span>
              <span className="json-colon">:</span>
            </>
          )}

          {/* Value or Type indicator */}
          {renderValue()}
        </div>

        {/* Children */}
        {renderChildren()}
      </div>
    );
  }
);
JsonNode.displayName = "JsonNode";

// ============================================
// Inline tree (e.g. Trajectory JSON view)
// ============================================

export interface DebugJsonTreeBodyProps {
  data: unknown;
  className?: string;
}

export const DebugJsonTreeBody: React.FC<DebugJsonTreeBodyProps> = memo(
  ({ data, className = "" }) => {
    return (
      <div
        className={`debug-json-viewer flex min-h-0 flex-1 flex-col ${className}`}
      >
        <div className="debug-json-viewer__content">
          <JsonNode
            keyName={null}
            value={data}
            depth={0}
            defaultExpanded={true}
          />
        </div>
      </div>
    );
  }
);
DebugJsonTreeBody.displayName = "DebugJsonTreeBody";
