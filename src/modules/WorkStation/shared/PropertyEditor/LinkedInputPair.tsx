/**
 * LinkedInputPair Component
 *
 * When linked: 2 inputs (vertical syncs top+bottom, horizontal syncs left+right)
 * When unlinked: 4 inputs (top, right, bottom, left)
 *
 * Used for Padding and Margin in property panels.
 */
import React, { memo, useCallback, useState } from "react";

import Input from "@src/components/Input";
import {
  AlignHorizontalSpaceAroundIcon,
  AlignVerticalSpaceAroundIcon,
  HugeiconsIcon,
} from "@src/icons";

import {
  SpacingBottom,
  SpacingLeft,
  SpacingRight,
  SpacingTop,
} from "./SpacingIcons";

// ============================================
// Types
// ============================================

export interface LinkedInputPairProps {
  /** Top value */
  topValue: number;
  /** Right value */
  rightValue: number;
  /** Bottom value */
  bottomValue: number;
  /** Left value */
  leftValue: number;
  /** Unit suffix (e.g., "px") */
  unit?: string;
  /** Handler for top value change */
  onTopChange: (value: string) => void;
  /** Handler for right value change */
  onRightChange: (value: string) => void;
  /** Handler for bottom value change */
  onBottomChange: (value: string) => void;
  /** Handler for left value change */
  onLeftChange: (value: string) => void;
  /** Whether values are linked (controlled by parent) */
  isLinked: boolean;
  /** Whether editing is disabled */
  disabled?: boolean;
}

// ============================================
// Single Input Component
// ============================================

interface SingleInputProps {
  value: number;
  unit: string;
  onChange: (value: string) => void;
  disabled: boolean;
  icon: React.ReactNode;
}

const SingleInput: React.FC<SingleInputProps> = memo(
  ({ value, unit, onChange, disabled, icon }) => {
    const [editing, setEditing] = useState<string | null>(null);
    const displayValue = editing !== null ? editing : String(value);

    const handleChange = useCallback((newValue: string) => {
      setEditing(newValue);
    }, []);

    const handleBlur = useCallback(() => {
      if (editing === null) return;
      const numValue = parseFloat(editing.trim());
      if (!isNaN(numValue)) {
        onChange(`${numValue}${unit}`);
      }
      setEditing(null);
    }, [editing, unit, onChange]);

    const handleFocus = useCallback(() => {
      setEditing(String(value));
    }, [value]);

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Enter" || event.key === "Escape") {
          (event.target as HTMLInputElement).blur();
        } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.preventDefault();
          const currentValue = editing ?? String(value);
          const currentNum = parseFloat(currentValue) || 0;
          const delta = event.key === "ArrowUp" ? 1 : -1;
          const newNum = Math.max(0, currentNum + delta);
          setEditing(String(newNum));
          onChange(`${newNum}${unit}`);
        }
      },
      [editing, value, unit, onChange]
    );

    return (
      <Input
        size="small"
        value={displayValue}
        onChange={handleChange}
        onBlur={handleBlur}
        onFocus={handleFocus}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        prefix={
          <span className="flex h-4 w-4 items-center justify-center text-text-2">
            {icon}
          </span>
        }
        suffix={<span className="text-[10px] text-text-2">{unit}</span>}
        className="input-pane-surface"
      />
    );
  }
);

SingleInput.displayName = "SingleInput";

// ============================================
// Main Component
// ============================================

export const LinkedInputPair: React.FC<LinkedInputPairProps> = memo(
  ({
    topValue,
    rightValue,
    bottomValue,
    leftValue,
    unit = "px",
    onTopChange,
    onRightChange,
    onBottomChange,
    onLeftChange,
    isLinked,
    disabled = false,
  }) => {
    // Linked handlers (always defined to avoid conditional hooks)
    const handleVerticalChange = useCallback(
      (value: string) => {
        onTopChange(value);
        onBottomChange(value);
      },
      [onTopChange, onBottomChange]
    );

    const handleHorizontalChange = useCallback(
      (value: string) => {
        onLeftChange(value);
        onRightChange(value);
      },
      [onLeftChange, onRightChange]
    );

    // Linked mode: 2 inputs (vertical = top+bottom, horizontal = left+right)
    if (isLinked) {
      return (
        <div className="grid grid-cols-2 gap-2">
          <SingleInput
            value={topValue}
            unit={unit}
            onChange={handleVerticalChange}
            disabled={disabled}
            icon={
              <HugeiconsIcon
                icon={AlignVerticalSpaceAroundIcon}
                data-icon="align-vertical-space-around"
                size={14}
              />
            }
          />
          <SingleInput
            value={leftValue}
            unit={unit}
            onChange={handleHorizontalChange}
            disabled={disabled}
            icon={
              <HugeiconsIcon
                icon={AlignHorizontalSpaceAroundIcon}
                data-icon="align-horizontal-space-around"
                size={14}
              />
            }
          />
        </div>
      );
    }

    // Unlinked mode: 4 inputs (top, right, bottom, left)
    return (
      <div className="grid grid-cols-2 gap-2">
        <SingleInput
          value={topValue}
          unit={unit}
          onChange={onTopChange}
          disabled={disabled}
          icon={<SpacingTop size={14} />}
        />
        <SingleInput
          value={rightValue}
          unit={unit}
          onChange={onRightChange}
          disabled={disabled}
          icon={<SpacingRight size={14} />}
        />
        <SingleInput
          value={bottomValue}
          unit={unit}
          onChange={onBottomChange}
          disabled={disabled}
          icon={<SpacingBottom size={14} />}
        />
        <SingleInput
          value={leftValue}
          unit={unit}
          onChange={onLeftChange}
          disabled={disabled}
          icon={<SpacingLeft size={14} />}
        />
      </div>
    );
  }
);

LinkedInputPair.displayName = "LinkedInputPair";

export default LinkedInputPair;
