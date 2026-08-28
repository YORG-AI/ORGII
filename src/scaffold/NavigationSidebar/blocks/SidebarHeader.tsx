/**
 * SidebarHeader
 *
 * Header component for sidebars with optional title, tabs, and actions.
 */
import React, { useCallback, useMemo } from "react";

import AnyIcon from "@src/components/AnyIcon";
import TabPill from "@src/components/TabPill";
import { SPINNER_TOKENS } from "@src/config/spinnerTokens";
import { HugeiconsIcon, Loading03Icon } from "@src/icons";

import type { SidebarHeaderProps } from "../types";
import { renderSidebarIcon } from "../utils/renderIcon";

// ============================================
// SidebarHeader Component
// ============================================

const SidebarHeader: React.FC<SidebarHeaderProps> = React.memo(
  ({
    title,
    icon,
    items,
    activeKey,
    onChange,
    tabStyle = "pill",
    actions,
    theme,
    className = "",
  }) => {
    // Theme-aware text style — memoized
    const textStyle = useMemo(
      () => (theme ? { color: theme.foreground } : undefined),
      [theme]
    );

    // Stable onChange handler for tabs
    const handleTabChange = useCallback(
      (key: string) => {
        onChange?.(key);
      },
      [onChange]
    );

    // Render title section
    const renderTitle = () => {
      if (!title) return null;

      return (
        <div className="flex h-9 items-end px-5">
          <div className="flex h-7 items-center gap-3 text-[13px] font-bold text-text-1">
            {renderSidebarIcon(icon, {
              className: theme ? "" : "text-text-1",
            })}
            <span style={textStyle}>{title}</span>
          </div>
        </div>
      );
    };

    // Render tabs section
    const renderTabs = () => {
      if (!items || items.length === 0) return null;

      if (tabStyle === "pill") {
        return (
          <div className="flex h-9 items-end px-3">
            <TabPill
              activeTab={activeKey || items[0]?.key || ""}
              iconOnly
              tabs={items.map((tab) => ({
                key: tab.key,
                label: tab.label,
                icon: tab.icon ? (
                  <AnyIcon
                    icon={tab.icon}
                    size={14}
                    className="h-[14px] w-[14px]"
                  />
                ) : undefined,
              }))}
              onChange={handleTabChange}
            />
          </div>
        );
      }

      // Text style tabs
      return (
        <div className="px-3">
          <div className="flex w-full items-center gap-3">
            {items.map((tab, index) => (
              <React.Fragment key={tab.key}>
                {index > 0 && (
                  <div className="mx-1 h-[14px] w-[1px] bg-border-2" />
                )}
                <div
                  className={`flex cursor-pointer items-center justify-center gap-3 text-[12px] ${
                    activeKey === tab.key ? "text-primary-5" : "text-text-2"
                  }`}
                  onClick={() => handleTabChange(tab.key)}
                  style={
                    theme
                      ? {
                          color:
                            activeKey === tab.key
                              ? theme.accent
                              : `${theme.foreground}60`,
                        }
                      : undefined
                  }
                >
                  {renderSidebarIcon(tab.icon, { size: 12 })}
                  <span>{tab.label}</span>
                </div>
              </React.Fragment>
            ))}
          </div>
        </div>
      );
    };

    // Render actions
    const renderActions = () => {
      if (!actions || actions.length === 0) return null;

      return (
        <div className="flex items-center gap-1 px-3">
          {actions.map((action) => (
            <button
              key={action.id}
              onClick={action.onClick}
              disabled={action.disabled || action.loading}
              className="flex h-[28px] w-[28px] items-center justify-center rounded-[6px] text-text-2 transition-colors hover:bg-bg-2 disabled:cursor-not-allowed disabled:opacity-50"
              title={action.tooltip}
            >
              {action.loading ? (
                <HugeiconsIcon
                  icon={Loading03Icon}
                  data-icon="loader-2"
                  size={SPINNER_TOKENS.default}
                  strokeWidth={2}
                  className="animate-spin"
                />
              ) : (
                renderSidebarIcon(action.icon)
              )}
            </button>
          ))}
        </div>
      );
    };

    return (
      <div className={`sidebar-header ${className}`}>
        {renderTitle()}
        {renderTabs()}
        {actions && actions.length > 0 && (
          <div className="flex items-center justify-end px-3 py-[8px]">
            {renderActions()}
          </div>
        )}
      </div>
    );
  }
);

SidebarHeader.displayName = "SidebarHeader";

export default SidebarHeader;
