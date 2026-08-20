/**
 * BlockSection - Labeled sub-section within a chat block
 *
 * Non-collapsible label header (e.g. "INPUT", "OUTPUT") that visually
 * separates content areas inside ToolCallBlock.
 * Content is always displayed; BlockOutput inside handles show-more-lines.
 */
import React, { memo } from "react";

// h-9 = 36px — matches EVENT_BLOCK_HEADER_HEIGHT / chat-block-header
const SECTION_HEADER_CLASSES =
  "flex h-9 items-center gap-1.5 px-3 text-[11px] text-text-2";

export interface BlockSectionProps {
  label: string;
  children?: React.ReactNode;
  /** Top border — use when stacking sections (e.g. Input above, Output below), same as TerminalBlock */
  borderTop?: boolean;
  /**
   * Optional trailing controls rendered on the right of the section header
   * (e.g. copy / jump-to-source buttons on a tool's OUTPUT section).
   */
  headerAction?: React.ReactNode;
}

const BlockSection: React.FC<BlockSectionProps> = memo(
  ({ label, children, borderTop = false, headerAction }) => (
    <div
      className={
        borderTop ? "border-t border-solid border-border-1" : undefined
      }
    >
      <div className={SECTION_HEADER_CLASSES}>
        <span className="select-text font-bold uppercase">{label}</span>
        {headerAction && (
          <div className="ml-auto flex select-none items-center gap-0.5">
            {headerAction}
          </div>
        )}
      </div>
      {children}
    </div>
  )
);

BlockSection.displayName = "BlockSection";

export default BlockSection;
