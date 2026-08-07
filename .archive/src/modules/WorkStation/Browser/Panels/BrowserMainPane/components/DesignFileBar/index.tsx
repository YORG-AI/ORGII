/**
 * DesignFileBar Component
 *
 * A 38px file/path bar for design content panels, similar to FileHeader in Code Editor.
 * Used by TokenManagerContent.
 */
import { type LucideIcon, Search } from "lucide-react";
import React, { memo, useCallback, useRef, useState } from "react";
import type { ReactNode } from "react";

import { HEADER_CLASSES } from "@src/modules/WorkStation/shared/tokens";

// ============================================
// Types
// ============================================

export interface DesignFileBarProps {
  /** Icon component to show on the left */
  icon: LucideIcon;
  /** Breadcrumb segments to display */
  segments: BreadcrumbSegment[];
  /** Optional actions to show on the right */
  actions?: ReactNode;
  /** Additional CSS classes */
  className?: string;
  /** Search input value (controlled) */
  searchValue?: string;
  /** Search input change handler */
  onSearchChange?: (value: string) => void;
  /** Search placeholder text */
  searchPlaceholder?: string;
}

export interface BreadcrumbSegment {
  /** Text content */
  text: string;
  /** Optional secondary text (shown in parentheses) */
  secondary?: string;
  /** Whether this is the primary/highlighted segment */
  primary?: boolean;
  /** Whether to capitalize the text */
  capitalize?: boolean;
}

// ============================================
// Component
// ============================================

export const DesignFileBar: React.FC<DesignFileBarProps> = memo(
  ({
    icon: Icon,
    segments,
    actions,
    className = "",
    searchValue,
    onSearchChange,
    searchPlaceholder = "Search...",
  }) => {
    const [isFocused, setIsFocused] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    const handleFocus = useCallback(() => {
      setIsFocused(true);
      setTimeout(() => {
        inputRef.current?.select();
      }, 50);
    }, []);

    const handleBlur = useCallback(() => {
      setIsFocused(false);
    }, []);

    const handleKeyDown = useCallback(
      (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "Escape") {
          inputRef.current?.blur();
        }
      },
      []
    );

    const showSearch = searchValue !== undefined && onSearchChange;

    return (
      <div className={`${HEADER_CLASSES.fileBar} ${className}`}>
        {/* Icon */}
        <Icon size={14} className="shrink-0 text-text-3" />

        {/* Breadcrumb segments */}
        {segments.map((segment, index) => (
          <React.Fragment key={index}>
            {/* Separator (except for first item) */}
            {index > 0 && (
              <span className="shrink-0 px-0.5 text-[11px] text-text-4">›</span>
            )}

            {/* Segment text */}
            <span
              className={`truncate px-1 text-[13px] ${
                segment.primary ? "font-medium text-text-1" : "text-text-2"
              } ${segment.capitalize ? "capitalize" : ""}`}
            >
              {segment.text}
            </span>

            {/* Secondary text */}
            {segment.secondary && (
              <span className="ml-0.5 shrink-0 text-[11px] text-text-4">
                ({segment.secondary})
              </span>
            )}
          </React.Fragment>
        ))}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Search Input (URL bar style) - centered */}
        {showSearch && (
          <div
            className="relative flex w-[240px] cursor-text items-center rounded-full bg-fill-2"
            onClick={() => {
              if (!isFocused) {
                inputRef.current?.focus();
              }
            }}
          >
            {/* Centered display when not focused */}
            {!isFocused && (
              <div className="absolute inset-0 flex items-center justify-center gap-1.5 px-2.5">
                <Search size={12} className="shrink-0 text-text-4" />
                <span className="truncate text-[12px] text-text-3">
                  {searchValue || searchPlaceholder}
                </span>
              </div>
            )}

            {/* Icon on left when focused */}
            {isFocused && (
              <div className="absolute left-2.5 flex items-center">
                <Search size={12} className="text-text-3" />
              </div>
            )}

            {/* Input */}
            <input
              ref={inputRef}
              type="text"
              value={searchValue}
              onChange={(event) => onSearchChange?.(event.target.value)}
              onFocus={handleFocus}
              onBlur={handleBlur}
              onKeyDown={handleKeyDown}
              placeholder={searchPlaceholder}
              className={`h-[24px] min-w-0 flex-1 border-none bg-transparent text-[12px] text-text-1 outline-none placeholder:text-text-3 ${
                isFocused ? "pl-7 pr-2.5" : "opacity-0"
              }`}
            />
          </div>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Actions */}
        {actions}
      </div>
    );
  }
);

DesignFileBar.displayName = "DesignFileBar";

export default DesignFileBar;
