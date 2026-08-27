import type { ReactNode } from "react";
import React, { memo } from "react";

import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import Tooltip, { type TooltipProps } from "@src/components/Tooltip";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";

export interface ToolbarTooltipProps {
  label: ReactNode;
  shortcut?: string;
  shortcutId?: string;
  position?: TooltipProps["position"];
  mouseEnterDelay?: TooltipProps["mouseEnterDelay"];
  disabled?: boolean;
  children: ReactNode;
}

export const ToolbarTooltip: React.FC<ToolbarTooltipProps> = memo(
  ({
    label,
    shortcut,
    shortcutId,
    position = "bottom",
    mouseEnterDelay = 200,
    disabled = false,
    children,
  }) => {
    const resolvedShortcut = shortcutId
      ? getShortcutKeys(shortcutId)
      : shortcut;

    return (
      <Tooltip
        content={
          <KeyboardShortcutTooltipContent
            label={label}
            shortcut={resolvedShortcut}
          />
        }
        position={position}
        mouseEnterDelay={mouseEnterDelay}
        framedPanel
        disabled={disabled}
        smartPlacement
      >
        <span className="inline-flex">{children}</span>
      </Tooltip>
    );
  }
);

ToolbarTooltip.displayName = "ToolbarTooltip";
