import type React from "react";

export interface SplitListHeaderProps {
  /** Context and navigation controls rendered in the first left-column row. */
  primary?: React.ReactNode;
  /** Filters, search, and actions rendered in the second left-column row. */
  secondary?: React.ReactNode;
  /** Align a full-width surface row with the host header's content inset. */
  fullWidth?: boolean;
  className?: string;
}

/**
 * Surface-owned header rows for a split list. This replaces a shell-wide
 * tab-header strip when a tab keeps its list and detail panes visible.
 */
const SplitListHeader: React.FC<SplitListHeaderProps> = ({
  primary,
  secondary,
  fullWidth = false,
  className = "",
}) => {
  if (!primary && !secondary) return null;

  return (
    <div
      className={`flex shrink-0 flex-col bg-chat-pane ${className}`.trim()}
      data-split-list-header="true"
    >
      {primary ? (
        <div
          className={`flex h-9 min-w-0 items-center gap-px ${
            fullWidth ? "pr-[7px] pl-[15px]" : "px-3"
          }`}
          data-split-list-header-row="primary"
        >
          {primary}
        </div>
      ) : null}
      {secondary ? (
        <div
          className={`flex h-9 min-w-0 items-center gap-px ${
            fullWidth ? "pr-[7px] pl-[15px]" : "px-3"
          }`}
          data-split-list-header-row="secondary"
        >
          {secondary}
        </div>
      ) : null}
    </div>
  );
};

export default SplitListHeader;
