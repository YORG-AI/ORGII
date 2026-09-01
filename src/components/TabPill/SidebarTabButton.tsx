import React, { useCallback } from "react";

import { useImmediateCursorReset } from "@src/hooks/ui/useImmediateCursorReset";

import { cn } from "./cn";
import { BoldStableLabel } from "./tabContent";
import type { TabPillItem } from "./types";

const SELECTED_TAB_PILL_STYLE: React.CSSProperties = {
  boxShadow: "var(--sidebar-tab-pill-selected-shadow)",
};

export const SidebarTabButton: React.FC<{
  tab: TabPillItem;
  isActive: boolean;
  onClick: () => void;
  iconOnly?: boolean;
}> = ({ tab, isActive, onClick, iconOnly }) => {
  const { cursorReset, markClicked, resetCursor } = useImmediateCursorReset(
    isActive,
    !tab.disabled
  );

  const handleClick = useCallback(() => {
    markClicked();
    onClick();
  }, [markClicked, onClick]);

  return (
    <button
      onClick={handleClick}
      disabled={tab.disabled}
      data-action="panel.setLeftTab"
      data-action-id={tab.key}
      data-testid={tab.dataTestId}
      onMouseLeave={resetCursor}
      className={cn(
        "group relative flex flex-1 items-center justify-center select-none",
        cursorReset || isActive ? "cursor-default" : "cursor-pointer",
        "rounded-[100px] border-none",
        "h-[28px] px-[10px]",
        isActive
          ? "bg-fill-2 text-text-1"
          : "bg-transparent text-text-2 hover:bg-fill-2 hover:text-text-1",
        tab.disabled && "cursor-not-allowed opacity-50",
        "transition-[background-color,color,box-shadow] duration-150"
      )}
      style={isActive ? SELECTED_TAB_PILL_STYLE : undefined}
      title={iconOnly ? tab.label : undefined}
    >
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 px-[10px]">
        {iconOnly && tab.icon && (
          <div
            className={cn(
              "flex shrink-0 items-center justify-center transition-colors duration-150 group-hover:text-text-1",
              isActive
                ? "text-primary-6 group-hover:text-primary-6"
                : "text-text-2"
            )}
          >
            {tab.icon}
          </div>
        )}
        {!iconOnly && (
          <span
            className={cn(
              "text-xs transition-colors duration-150 group-hover:text-text-1",
              isActive ? "text-text-1" : "text-text-2"
            )}
          >
            <BoldStableLabel label={tab.label} isBold={isActive} />
          </span>
        )}
      </div>
    </button>
  );
};
