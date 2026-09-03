/**
 * WorkspaceContextRow — a read-only (or click-through) scope row in the rail:
 * repo, branch, worktree, or the linked work item.
 */
import AnyIcon from "@src/components/AnyIcon";
import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip from "@src/components/Tooltip";
import { WORKSTATION_TRAIL_CONTENT } from "@src/config/workstation/tokens";
import { ArrowDown01Icon, ArrowUp01Icon, HugeiconsIcon } from "@src/icons";

import type { FocusedChatRailIcon } from "./types";

export function WorkspaceContextRow({
  active = false,
  ariaLabel,
  chevron = false,
  compact = false,
  icon,
  label,
  onClick,
  onRequestClose,
  testId,
  title,
}: {
  /** Switcher popup currently open: chevron flips up, hover highlight sticks. */
  active?: boolean;
  ariaLabel?: string;
  /** Trailing chevron affordance for switcher rows. */
  chevron?: boolean;
  compact?: boolean;
  icon: FocusedChatRailIcon;
  label: string;
  onClick?: () => void;
  onRequestClose?: () => void;
  testId?: string;
  title?: string;
}) {
  const className = compact
    ? "flex h-8 min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 text-text-1"
    : `${WORKSTATION_TRAIL_CONTENT.row} ${WORKSTATION_TRAIL_CONTENT.rowHorizontalPadding} gap-1.5 overflow-hidden text-text-1`;
  const content = (
    <>
      <AnyIcon icon={icon} className="shrink-0" size={14} strokeWidth={1.75} />
      <span
        className={`min-w-0 flex-1 truncate ${
          compact ? "text-[13px]" : "text-[12px]"
        }`}
      >
        {label}
      </span>
      {chevron && (
        <HugeiconsIcon
          icon={active ? ArrowUp01Icon : ArrowDown01Icon}
          data-icon={active ? "chevron-up" : "chevron-down"}
          aria-hidden
          className="shrink-0 text-text-2"
          size={14}
          strokeWidth={1.75}
        />
      )}
    </>
  );

  if (onClick) {
    // Switcher rows with an explicit action title get the rail's styled
    // tooltip; other clickable rows keep the native title.
    const styledTooltip = chevron && title ? title : undefined;
    const button = (
      <button
        type="button"
        className={`${className} w-full text-left transition-colors hover:bg-fill-2 ${
          active ? "bg-fill-2" : ""
        }`}
        title={styledTooltip ? undefined : (title ?? label)}
        aria-label={ariaLabel}
        aria-expanded={chevron ? active : undefined}
        data-testid={testId}
        role={compact ? "menuitem" : undefined}
        onClick={() => {
          onRequestClose?.();
          onClick();
        }}
      >
        {content}
      </button>
    );

    if (styledTooltip) {
      return (
        <Tooltip
          content={<KeyboardShortcutTooltipContent label={styledTooltip} />}
          position="left"
          framedPanel
          mouseEnterDelay={200}
          smartPlacement
        >
          {button}
        </Tooltip>
      );
    }
    return button;
  }

  return (
    <div className={className} title={title ?? label} data-testid={testId}>
      {content}
    </div>
  );
}
