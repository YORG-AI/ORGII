/**
 * SidebarChromeIconButton
 *
 * The sidebar header's icon control. It is the chat pane header's own
 * `Button` (tertiary, small, icon-only: 28px, 8px radius) with a single
 * difference — the hover fill is the sidebar's token — so chrome drawn over
 * either surface shares one exact shape and size.
 */
import React, { memo } from "react";

import Button from "@src/components/Button";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";

/** Swap the tertiary button's hover fill for the sidebar's selected-row token. */
export const SIDEBAR_CHROME_BUTTON_HOVER_CLASS =
  "enabled:hover:bg-sidebar-selected! enabled:active:bg-sidebar-selected!";

export interface SidebarChromeIconButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "className" | "onClick" | "title" | "type"
> {
  title: string;
  onClick?: () => void;
  shortcutId?: string;
  tooltipPosition?: "top" | "bottom" | "bottom-start" | "bottom-end";
  className?: string;
  children: React.ReactNode;
}

export const SidebarChromeIconButton: React.FC<SidebarChromeIconButtonProps> =
  memo(
    ({
      title,
      onClick,
      shortcutId,
      tooltipPosition = "bottom",
      className = "",
      children,
      ...buttonProps
    }) => (
      <ToolbarTooltip
        label={title}
        shortcutId={shortcutId}
        position={tooltipPosition}
      >
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          className={`${SIDEBAR_CHROME_BUTTON_HOVER_CLASS} ${className}`.trim()}
          aria-label={buttonProps["aria-label"] ?? title}
          onClick={onClick}
          icon={children}
          {...buttonProps}
        />
      </ToolbarTooltip>
    )
  );

SidebarChromeIconButton.displayName = "SidebarChromeIconButton";

export default SidebarChromeIconButton;
