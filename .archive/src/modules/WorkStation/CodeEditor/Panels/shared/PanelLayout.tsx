/**
 * PanelLayout Component
 *
 * Standard layout structure for bottom panel content:
 * - Optional header with summary/controls
 * - Scrollable content area
 * - Optional footer
 *
 * Used by ProblemsContent, OutputContent, and TestResultsContent.
 */
import React, { memo } from "react";

// ============================================
// Types
// ============================================

export interface PanelLayoutProps {
  /** Panel content */
  children: React.ReactNode;
  /** Optional header content (summary, controls) */
  header?: React.ReactNode;
  /** Optional footer content */
  footer?: React.ReactNode;
  /** Base class name for the panel (used for BEM naming) */
  panelClassName?: string;
  /** Additional class name */
  className?: string;
}

// ============================================
// Component
// ============================================

export const PanelLayout: React.FC<PanelLayoutProps> = memo(
  ({ children, header, footer, panelClassName = "", className = "" }) => {
    return (
      <div className={`flex h-full flex-col ${panelClassName} ${className}`}>
        {/* Header */}
        {header && (
          <div className="flex-shrink-0 border-b border-border-2">{header}</div>
        )}

        {/* Scrollable content */}
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="flex-shrink-0 border-t border-border-2">{footer}</div>
        )}
      </div>
    );
  }
);

PanelLayout.displayName = "PanelLayout";

// ============================================
// PanelHeader - Common header structure
// ============================================

export interface PanelHeaderProps {
  /** Left side content (typically summary badges) */
  left?: React.ReactNode;
  /** Right side content (typically action buttons) */
  right?: React.ReactNode;
  /** Additional class name */
  className?: string;
}

export const PanelHeader: React.FC<PanelHeaderProps> = memo(
  ({ left, right, className = "" }) => {
    return (
      <div
        className={`flex items-center justify-between px-3 py-2 ${className}`}
      >
        <div className="flex items-center gap-3">{left}</div>
        <div className="flex items-center gap-1.5">{right}</div>
      </div>
    );
  }
);

PanelHeader.displayName = "PanelHeader";

export default PanelLayout;
