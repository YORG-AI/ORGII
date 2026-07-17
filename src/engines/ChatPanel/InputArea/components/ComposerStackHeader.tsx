/**
 * ComposerStackHeader
 *
 * Shared collapsible/non-collapsible header used by stacked bars above the
 * chat composer (QueuedMessages, CompactFileChanges, etc.).
 *
 * Renders a left icon (swaps to chevron on hover), label area, optional
 * badges, and optional right-side actions slot.
 *
 * `labelVariant="primary"` renders the label in primary-6 (used by Question,
 * Permission, ModeSwitch). Default renders in text-2.
 *
 * Hover color change is scoped to the header row only (not the expanded body).
 */
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import React, { memo, useCallback, useState } from "react";

export interface ComposerStackHeaderProps {
  /** Header label text */
  label: string;
  /** Default icon shown when not hovered. When omitted, always shows chevron. */
  icon?: React.ReactNode;
  /** Whether the section is expanded (enables chevron toggle). Omit for non-collapsible headers. */
  expanded?: boolean;
  /** Toggle callback for expand/collapse. Required when `expanded` is provided. */
  onToggle?: () => void;
  /** Optional inline badges rendered right of the label (e.g. diff stats). */
  badges?: React.ReactNode;
  /** Optional action buttons rendered on the right side. */
  actions?: React.ReactNode;
  /**
   * Color variant for icon + label:
   * - `default` — muted icon (text-3 → text-1 hover), text-2 label (→ text-1 hover).
   * - `primary` — primary-6 (→ primary-7 hover) for both.
   */
  labelVariant?: "default" | "primary";
}

const ICON_SIZE = 14;

const ICON_BASE =
  "flex h-[14px] w-[14px] shrink-0 items-center justify-center transition-colors";
const LABEL_BASE = "min-w-0 truncate text-[13px] font-medium transition-colors";

const COLOR = {
  default: {
    icon: "text-text-3",
    iconHover: "text-text-1",
    label: "text-text-2",
    labelHover: "text-text-1",
  },
  primary: {
    icon: "text-primary-6",
    iconHover: "text-primary-7",
    label: "text-primary-6",
    labelHover: "text-primary-7",
  },
} as const;

const ComposerStackHeader: React.FC<ComposerStackHeaderProps> = memo(
  ({
    label,
    icon,
    expanded,
    onToggle,
    badges,
    actions,
    labelVariant = "default",
  }) => {
    const isCollapsible = expanded !== undefined && onToggle;
    const [hovered, setHovered] = useState(false);
    const onEnter = useCallback(() => setHovered(true), []);
    const onLeave = useCallback(() => setHovered(false), []);

    const showChevron = isCollapsible && (!icon || hovered);
    const colors = COLOR[labelVariant];

    const chevronNode = expanded ? (
      <ChevronsDownUp size={ICON_SIZE} />
    ) : (
      <ChevronsUpDown size={ICON_SIZE} />
    );

    const iconSlot = (
      <div
        className={`${ICON_BASE} ${hovered ? colors.iconHover : colors.icon}`}
      >
        {showChevron ? chevronNode : icon}
      </div>
    );

    const labelClass = `${LABEL_BASE} ${hovered ? colors.labelHover : colors.label}`;

    return (
      <div
        className="flex h-8 items-center gap-1.5 px-2.5"
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
      >
        {isCollapsible ? (
          <button
            onClick={onToggle}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent p-0 text-left"
          >
            {iconSlot}
            <span className={labelClass}>{label}</span>
            {badges}
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            {icon && iconSlot}
            <span className={labelClass}>{label}</span>
            {badges}
          </span>
        )}

        {actions && <div className="flex items-center gap-0.5">{actions}</div>}
      </div>
    );
  }
);

ComposerStackHeader.displayName = "ComposerStackHeader";

export default ComposerStackHeader;

/**
 * Progress count badge for stack headers (e.g. todo / task bars showing
 * "completed / total"). Shared so todo-style bars render the count
 * identically — do NOT hand-roll the span per consumer.
 *
 * Pass already-formatted text as children (callers own i18n / number
 * formatting); this component owns only the visual treatment.
 */
export const ComposerStackHeaderCountBadge: React.FC<{
  children: React.ReactNode;
}> = memo(({ children }) => (
  <span className="ml-1 shrink-0 text-[13px] font-medium tabular-nums text-text-3">
    {children}
  </span>
));

ComposerStackHeaderCountBadge.displayName = "ComposerStackHeaderCountBadge";
