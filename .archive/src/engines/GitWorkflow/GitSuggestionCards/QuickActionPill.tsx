/**
 * QuickActionPill
 *
 * Shared base for the pill-shaped row items used in Control Tower
 * Quick Actions section.
 *
 * Two modes:
 *  - Default (no `button` prop): entire pill is one clickable button.
 *    Right side always reserves space for an ArrowRight icon that
 *    fades in on hover — no layout shift.
 *  - With `button` prop: outer shell is a non-interactive div; the
 *    provided button node is rendered on the right, always visible.
 */
import React from "react";

import { useSafeHover } from "@src/hooks/ui/useSafeHover";
import { ArrowRight02Icon, HugeiconsIcon } from "@src/icons";

export interface QuickActionPillProps {
  /** Left-side icon element */
  icon?: React.ReactNode;
  /** Primary label text */
  label: React.ReactNode;
  /**
   * When provided, rendered as the right-side action (always visible).
   * The outer shell becomes a non-interactive div.
   * When omitted, the whole pill is a button and shows a hover arrow.
   */
  button?: React.ReactNode;
  /** Click handler — used only when `button` is NOT provided */
  onAction?: () => void;
}

const PILL_SHELL_CLASS =
  "flex h-[36px] w-fit items-center gap-3 rounded-full border border-solid border-border-2 bg-bg-2 pl-4 pr-2 transition-[border-color] duration-150 hover:border-border-3";

const LabelContent: React.FC<{
  icon?: React.ReactNode;
  label: React.ReactNode;
}> = ({ icon, label }) => (
  <>
    {icon && <span className="shrink-0 text-text-2 [&>svg]:block">{icon}</span>}
    <span className="truncate text-[13px] font-medium text-text-1">
      {label}
    </span>
  </>
);

const QuickActionPill: React.FC<QuickActionPillProps> = ({
  icon,
  label,
  button,
  onAction,
}) => {
  const [hoverRef, isHovered] = useSafeHover<HTMLButtonElement>();

  if (button) {
    return (
      <div className={PILL_SHELL_CLASS}>
        <LabelContent icon={icon} label={label} />
        <span className="shrink-0">{button}</span>
      </div>
    );
  }

  return (
    <button
      ref={hoverRef}
      type="button"
      onClick={onAction}
      className={`${PILL_SHELL_CLASS} focus:outline-none`}
    >
      <LabelContent icon={icon} label={label} />
      {/* Reserves space always; fades in on hover */}
      <HugeiconsIcon
        icon={ArrowRight02Icon}
        data-icon="arrow-right"
        size={14}
        strokeWidth={1.75}
        className={`shrink-0 transition-opacity duration-150 ${
          isHovered ? "text-text-2 opacity-100" : "text-text-3 opacity-0"
        }`}
      />
    </button>
  );
};

export default QuickActionPill;
