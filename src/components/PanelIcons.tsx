/**
 * Custom panel layout SVG icons with optional sidebar fill.
 *
 * When `fillSidebar` / `fillPanel` is true, the panel portion is
 * filled with `currentColor` to indicate the panel is open.
 *
 * Shared by: SimulatorTitleBar, BaseStatusBar.
 */
import React, { memo } from "react";

interface PanelIconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
  /** Fill the sidebar portion (panel is open). */
  fillSidebar?: boolean;
}

export const PanelLeftIcon: React.FC<PanelIconProps> = memo(
  ({ size = 16, strokeWidth = 1.75, className = "", fillSidebar = false }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {fillSidebar && (
        <path
          d="M5 3h4v18H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"
          fill="currentColor"
          stroke="none"
        />
      )}
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </svg>
  )
);
PanelLeftIcon.displayName = "PanelLeftIcon";

export const PanelRightIcon: React.FC<PanelIconProps> = memo(
  ({ size = 16, strokeWidth = 1.75, className = "", fillSidebar = false }) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      {fillSidebar && (
        <path
          d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4V3z"
          fill="currentColor"
          stroke="none"
        />
      )}
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
    </svg>
  )
);
PanelRightIcon.displayName = "PanelRightIcon";
