/**
 * StackPill
 *
 * Individual pill button for a single ComposerStack section (queue, processes,
 * file changes) or a scroll-nav action (go-to-bottom, follow agent).
 * Rendered in a horizontal row above the InputArea composer.
 *
 * Default: icon + numeric count.
 * label: icon + text label (used for primary-card pills).
 * iconOnly: icon only (used for action pills at row trailing end).
 */
import React, { forwardRef, memo } from "react";

import { pillControlStateClass } from "@src/components/CompoundPill/config";

export interface StackPillProps {
  icon?: React.ReactNode;
  count: number;
  active: boolean;
  onClick: () => void;
  /** When set, renders this text instead of the numeric count. */
  label?: string;
  /** When true, renders icon only — no count or label. Used for action pills. */
  iconOnly?: boolean;
  /** Optional custom content rendered after the leading icon. */
  content?: React.ReactNode;
  /** Stable selector for rendered UI E2E coverage. */
  testId?: string;
  /** Native title for plain hover hints. */
  title?: string;
  /** Accessible label when the visual content is icon-only or abbreviated. */
  ariaLabel?: string;
  /** Extra classes for caller-specific sizing constraints. */
  className?: string;
  onMouseDown?: React.MouseEventHandler<HTMLButtonElement>;
  onMouseUp?: React.MouseEventHandler<HTMLButtonElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLButtonElement>;
  /** "primary" uses primary-6 colors instead of the default text-2 palette. */
  variant?: "default" | "primary";
}

const StackPill = memo(
  forwardRef<HTMLButtonElement, StackPillProps>(
    (
      {
        icon,
        count,
        active,
        onClick,
        label,
        iconOnly = false,
        content,
        testId,
        title,
        ariaLabel,
        className,
        onMouseDown,
        onMouseUp,
        onMouseLeave,
        variant = "default",
      },
      ref
    ) => (
      <button
        ref={ref}
        type="button"
        data-testid={testId}
        title={title}
        aria-label={ariaLabel}
        onClick={onClick}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        className={[
          "flex h-[28px] shrink-0 cursor-pointer items-center gap-1.5 rounded-full border leading-none transition-colors duration-150",
          iconOnly ? "w-[28px] justify-center px-0" : "px-2",
          "text-[13px] font-medium",
          pillControlStateClass(active),
          active
            ? ""
            : variant === "primary"
              ? "border-primary-5 text-primary-6"
              : "border-border-2 text-text-2",
          className,
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {icon && (
          <span className="flex h-[16px] w-[16px] shrink-0 items-center justify-center leading-none text-current [&_svg]:block [&_svg]:stroke-current [&_svg]:text-current">
            {icon}
          </span>
        )}
        {!iconOnly &&
          (content ?? (
            <span className="flex items-center leading-none">
              {label ?? count}
            </span>
          ))}
      </button>
    )
  )
);

StackPill.displayName = "StackPill";

export default StackPill;
