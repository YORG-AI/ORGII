/**
 * Shared icon-only control for tab-bar trailing areas.
 * Children supply the icon, including any per-icon size / stroke overrides.
 */
import React, { memo } from "react";

import Button from "@src/components/Button";
import { ToolbarTooltip } from "@src/components/KeyboardShortcut/ToolbarTooltip";

export interface TabBarTrailingIconButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "children" | "className" | "onClick" | "title" | "type"
> {
  title: string;
  onClick?: () => void;
  /** Toggled / pressed appearance (`tabBarTrailingActive`) */
  active?: boolean;
  shortcutId?: string;
  tooltipPosition?: "top" | "bottom" | "bottom-start" | "bottom-end";
  tooltipDisabled?: boolean;
  nativeTitle?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const TabBarTrailingIconButton: React.FC<TabBarTrailingIconButtonProps> =
  memo(
    ({
      title,
      onClick,
      active = false,
      shortcutId,
      tooltipPosition = "bottom",
      tooltipDisabled = false,
      nativeTitle = true,
      className = "",
      children,
      ...buttonProps
    }) => {
      const button = (
        <Button
          htmlType="button"
          variant="tertiary"
          size="small"
          iconOnly
          className={`${active ? "!bg-fill-1 !text-primary-6" : ""} ${className}`.trim()}
          title={nativeTitle && !shortcutId ? title : undefined}
          aria-label={buttonProps["aria-label"] ?? title}
          onClick={onClick}
          icon={children}
          {...buttonProps}
        />
      );

      return (
        <ToolbarTooltip
          label={title}
          shortcutId={shortcutId}
          position={tooltipPosition}
          disabled={tooltipDisabled}
        >
          {button}
        </ToolbarTooltip>
      );
    }
  );

TabBarTrailingIconButton.displayName = "TabBarTrailingIconButton";
