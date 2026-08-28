/**
 * InternalHeader Component
 *
 * Reusable header for internal content areas (e.g. profile, detail panels).
 * Supports title, optional icon, right-side actions, and optional tabs.
 * When tabs are present, they are vertically centered with bottom padding only.
 *
 * Standard: no border, wide padding (px-6), solid panel background.
 */
import React, { memo } from "react";

import { HugeiconsIcon, type IconSvgElement } from "@src/icons";

// ============================================
// Tokens
// ============================================

export const INTERNAL_HEADER_TOKENS = {
  /** Font size for title text */
  fontSize: 13,
  /** Icon size for title icons */
  iconSize: 14,
  /** Standard: no border, px-6, solid panel background */
  standard: {
    borderBottom: false,
    background: "default" as const,
  },
} as const;

// ============================================
// Types
// ============================================

export interface InternalHeaderProps {
  /** Title text */
  title?: string;

  /** Hugeicons icon data (size=14 applied automatically) */
  icon?: IconSvgElement;

  /** Custom icon element for non-glyph icons */
  iconElement?: React.ReactNode;

  /** Right-side actions (buttons, etc.) */
  actions?: React.ReactNode;

  /** Tabs (e.g. TabPill) — vertically centered with bottom padding only */
  tabs?: React.ReactNode;

  /** Additional className */
  className?: string;

  /** Skip horizontal padding (px-6). Use when the parent handles width constraints. */
  noPadding?: boolean;

  /**
   * Use px-4 to match the scroll content below (DETAIL_PANEL_TOKENS.scrollContent).
   * Prevents headers from touching the edge when the panel is narrow.
   */
  contentPadding?: boolean;

  /** Use px-3 for tighter detail header rows. */
  compactPadding?: boolean;

  /** When true, draws a bottom border under the header block. */
  borderBottom?: boolean;

  /** Background style. Default: "default" (panel surface) */
  background?: "default" | "transparent";

  /** Add top padding when no PanelHeader sits above this header. */
  noPanelHeader?: boolean;

  dataTestId?: string;
}

// ============================================
// Component
// ============================================

const InternalHeader: React.FC<InternalHeaderProps> = memo(
  ({
    title,
    icon: Icon,
    iconElement,
    actions,
    tabs,
    className = "",
    noPadding = false,
    contentPadding = false,
    compactPadding = false,
    borderBottom = false,
    background = "default",
    noPanelHeader = false,
    dataTestId,
  }) => {
    const paddingClass = compactPadding
      ? "px-3"
      : contentPadding
        ? "px-4"
        : noPadding
          ? ""
          : "px-6";
    const borderClasses = borderBottom ? "border-b border-border-2" : "";
    const bgClasses = background === "transparent" ? "" : "";
    const topPadding = noPanelHeader ? "pt-4" : "";
    const hasTitleRow = !!(title || iconElement || Icon);

    return (
      <div
        className={`relative z-50 flex flex-shrink-0 flex-col ${topPadding} ${paddingClass} ${borderClasses} ${bgClasses} ${className}`}
        data-testid={dataTestId}
        style={
          {
            WebkitAppRegion: "no-drag",
            pointerEvents: "auto",
          } as React.CSSProperties
        }
      >
        {hasTitleRow && (
          <div className="flex h-12 items-center gap-2">
            {iconElement && (
              <span className="flex-shrink-0 text-text-2">{iconElement}</span>
            )}
            {!iconElement && Icon && (
              <HugeiconsIcon
                icon={Icon}
                size={INTERNAL_HEADER_TOKENS.iconSize}
                className="flex-shrink-0 text-text-2"
              />
            )}
            {title && (
              <span
                className="truncate font-medium text-text-1"
                style={{ fontSize: INTERNAL_HEADER_TOKENS.fontSize }}
              >
                {title}
              </span>
            )}
            <div className="min-w-0 flex-1" />
            {actions && (
              <div className="flex flex-shrink-0 items-center gap-2">
                {actions}
              </div>
            )}
          </div>
        )}
        {tabs && (
          <div className="relative z-10 flex items-center pb-3">
            {tabs}
            {!hasTitleRow && actions && (
              <>
                <div className="min-w-0 flex-1" />
                <div className="flex flex-shrink-0 items-center gap-2">
                  {actions}
                </div>
              </>
            )}
          </div>
        )}
        {!hasTitleRow && !tabs && actions && (
          <div className="flex items-center justify-end pb-3">
            <div className="flex flex-shrink-0 items-center gap-2">
              {actions}
            </div>
          </div>
        )}
      </div>
    );
  }
);

InternalHeader.displayName = "InternalHeader";

export default InternalHeader;
