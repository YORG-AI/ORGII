/**
 * SidebarSearch
 *
 * Search input component for sidebars with optional action buttons.
 */
import React from "react";

import Input from "@src/components/Input";
import { HugeiconsIcon, Loading03Icon } from "@src/icons";

import { SIDEBAR_STYLE } from "../config";
import type { SidebarSearchProps } from "../types";
import { renderSidebarIcon } from "../utils/renderIcon";

// ============================================
// SidebarSearch Component
// ============================================

const SidebarSearch: React.FC<SidebarSearchProps> = ({
  value,
  onChange,
  placeholder = "Search...",
  actions,
  theme,
  className = "",
}) => {
  // Theme-aware input style
  const inputStyle = theme
    ? {
        height: `${SIDEBAR_STYLE.searchHeight}px`,
        backgroundColor: `${theme.foreground}10`,
        borderColor: `${theme.foreground}30`,
        color: theme.foreground,
      }
    : { height: `${SIDEBAR_STYLE.searchHeight}px` };

  const inputClassName = theme ? "" : "border-border-2 bg-bg-2";

  // Theme-aware button style
  const buttonStyle = theme
    ? {
        backgroundColor: `${theme.foreground}10`,
        borderColor: `${theme.foreground}30`,
      }
    : undefined;

  const buttonClassName = theme
    ? ""
    : "border-border-2 bg-bg-2 hover:bg-bg-3 disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <div className={`sidebar-search px-4 py-[8px] ${className}`}>
      <div className="flex items-center gap-3">
        <Input
          placeholder={placeholder}
          className={inputClassName}
          style={inputStyle}
          value={value}
          onChange={onChange}
        />
        {actions?.map((action) => (
          <button
            key={action.id}
            onClick={action.onClick}
            disabled={action.disabled || action.loading}
            className={`flex shrink-0 cursor-pointer items-center justify-center rounded-[6px] border border-solid text-[14px] transition-colors ${buttonClassName}`}
            style={{
              height: SIDEBAR_STYLE.actionButtonSize,
              width: SIDEBAR_STYLE.actionButtonSize,
              ...buttonStyle,
            }}
            title={action.tooltip}
          >
            {action.loading ? (
              <HugeiconsIcon
                icon={Loading03Icon}
                data-icon="loader-2"
                size={14}
                strokeWidth={2}
                className={`animate-spin ${theme ? "" : "text-text-2"}`}
              />
            ) : (
              renderSidebarIcon(action.icon, {
                className: theme ? "" : "text-text-2",
              })
            )}
          </button>
        ))}
      </div>
    </div>
  );
};

export default SidebarSearch;
