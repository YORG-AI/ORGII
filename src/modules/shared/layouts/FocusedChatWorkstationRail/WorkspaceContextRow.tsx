/**
 * WorkspaceContextRow — a read-only (or click-through) scope row in the rail:
 * repo, branch, worktree, or the linked work item.
 */
import AnyIcon from "@src/components/AnyIcon";
import { WORKSTATION_TRAIL_CONTENT } from "@src/config/workstation/tokens";
import type { IconSvgElement } from "@src/icons";

export function WorkspaceContextRow({
  compact = false,
  icon,
  label,
  onClick,
  onRequestClose,
  testId,
  title,
}: {
  compact?: boolean;
  icon: IconSvgElement;
  label: string;
  onClick?: () => void;
  onRequestClose?: () => void;
  testId?: string;
  title?: string;
}) {
  const className = compact
    ? "flex h-8 min-w-0 items-center gap-2 overflow-hidden rounded-md px-2 text-text-1"
    : `${WORKSTATION_TRAIL_CONTENT.row} gap-1.5 overflow-hidden px-2 text-text-1`;
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
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={`${className} w-full text-left transition-colors hover:bg-fill-2`}
        title={title ?? label}
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
  }

  return (
    <div className={className} title={title ?? label} data-testid={testId}>
      {content}
    </div>
  );
}
