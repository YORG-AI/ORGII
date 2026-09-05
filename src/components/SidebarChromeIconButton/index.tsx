/**
 * SidebarChromeIconButton
 *
 * The sidebar header's icon control: a 28px button with the chat pane
 * header's 8px radius, on the sidebar's own hover token. Counterpart of `TabBarTrailingIconButton`, which is the
 * same control in the chat pane's tokens; chrome that can sit over either
 * surface picks one or the other by host.
 */
import React, { memo } from "react";

import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";

// Same 8px radius as `Button` (the chat pane header's control), so chrome on
// either surface shares one shape; only the hover token differs.
export const SIDEBAR_CHROME_ICON_BUTTON_CLASS =
  "flex h-[28px] w-[28px] items-center justify-center rounded-lg border-none bg-transparent p-0 text-text-2 transition-colors duration-150";
const ENABLED_CLASS = "cursor-pointer hover:bg-sidebar-selected";
const DISABLED_CLASS = "cursor-default opacity-40";

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
      disabled = false,
      ...buttonProps
    }) => (
      <ToolbarTooltip
        label={title}
        shortcutId={shortcutId}
        position={tooltipPosition}
      >
        <button
          type="button"
          className={`${SIDEBAR_CHROME_ICON_BUTTON_CLASS} ${
            disabled ? DISABLED_CLASS : ENABLED_CLASS
          } ${className}`.trim()}
          aria-label={buttonProps["aria-label"] ?? title}
          disabled={disabled}
          onClick={onClick}
          {...buttonProps}
        >
          {children}
        </button>
      </ToolbarTooltip>
    )
  );

SidebarChromeIconButton.displayName = "SidebarChromeIconButton";

export default SidebarChromeIconButton;
