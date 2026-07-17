/**
 * InlineEditCell Component
 *
 * Every cell is always an <input>. No switching between span/input.
 * - View mode: readonly input with transparent bg
 * - Edit mode: editable input with bg-bg-1
 */
import React, { memo, useCallback, useEffect, useRef, useState } from "react";

export interface InlineEditCellProps {
  value: unknown;
  columnType: string;
  isEditing: boolean;
  isSelected?: boolean;
  stateClass?: "modified" | "deleted" | "inserted" | "updated";
  onClick?: () => void;
  onDoubleClick?: () => void;
  onSave: (newValue: unknown) => void;
  onCancel: () => void;
}

function parseValue(input: string, type: string): unknown {
  const upper = type.toUpperCase();
  if (input.toLowerCase() === "null" || input === "") return null;
  if (upper.includes("INT")) {
    const num = parseInt(input, 10);
    return isNaN(num) ? input : num;
  }
  if (
    upper.includes("REAL") ||
    upper.includes("FLOAT") ||
    upper.includes("DOUBLE")
  ) {
    const num = parseFloat(input);
    return isNaN(num) ? input : num;
  }
  return input;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export const InlineEditCell: React.FC<InlineEditCellProps> = memo(
  ({
    value,
    columnType,
    isEditing,
    isSelected,
    stateClass,
    onClick,
    onDoubleClick,
    onSave,
    onCancel,
  }) => {
    const [inputValue, setInputValue] = useState(() => formatValue(value));
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
      if (isEditing && inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
      }
    }, [isEditing]);

    useEffect(() => {
      setInputValue(formatValue(value));
    }, [value]);

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent) => {
        if (event.key === "Enter") {
          event.preventDefault();
          onSave(parseValue(inputValue, columnType));
        } else if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        }
      },
      [inputValue, columnType, onSave, onCancel]
    );

    const handleBlur = useCallback(() => {
      if (isEditing) {
        onSave(parseValue(inputValue, columnType));
      }
    }, [isEditing, inputValue, columnType, onSave]);

    // State class for row-level indicators
    const stateStyles = {
      modified: "bg-warning-6/15",
      deleted: "bg-danger-6/10 line-through text-text-4 cursor-not-allowed",
      inserted: "bg-success-6/10",
      updated: "bg-warning-6/5",
    };
    const stateClassName = stateClass ? stateStyles[stateClass] : "";

    // Editing: bg-bg-1. Otherwise transparent (inherits row hover/selection).
    const bgClass = isEditing ? "cursor-text bg-bg-1" : "bg-transparent";
    // Primary-6 outline for selected cell (kept during editing)
    const outlineClass = isSelected
      ? "outline outline-1 -outline-offset-1 outline-primary-6"
      : "";

    return (
      <input
        ref={inputRef}
        type="text"
        readOnly={!isEditing}
        value={inputValue}
        onChange={(event) => setInputValue(event.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={handleBlur}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        placeholder={value === null || value === undefined ? "NULL" : ""}
        className={`data-grid__input block w-full cursor-default truncate border-none px-2 text-xs text-text-1 ${bgClass} ${outlineClass || "outline-none"} ${stateClassName}`}
      />
    );
  }
);

InlineEditCell.displayName = "InlineEditCell";
export default InlineEditCell;
