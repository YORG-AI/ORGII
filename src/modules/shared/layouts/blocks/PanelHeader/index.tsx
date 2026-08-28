/**
 * PanelHeader Component
 *
 * Reusable 40px header for panels with multiple variants:
 * - Simple title with optional icon
 * - Back button + breadcrumb (for subpages)
 * - Title + right-side actions
 *
 * Font size matches PageBreadcrumb (13px)
 *
 * ## Button Standardization
 *
 * ALL icon-only buttons in 40px headers use 24×24 circles:
 *
 * ```tsx
 * // Normal action button (hover: fill-2)
 * <Button {...PANEL_HEADER_TOKENS.actionButton}
 *   icon={<Icon size={PANEL_HEADER_TOKENS.buttonIconSize} strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth} />} />
 *
 * // Danger button (hover: danger-1, for destructive actions like delete/uninstall only)
 * <Button {...PANEL_HEADER_TOKENS.dangerButton}
 *   icon={<Icon size={PANEL_HEADER_TOKENS.buttonIconSize} strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth} />} />
 *
 * // Close/cancel buttons: use actionButton, NOT dangerButton
 * <Button {...PANEL_HEADER_TOKENS.actionButton}
 *   icon={<X size={PANEL_HEADER_TOKENS.buttonIconSize} strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth} />} />
 *
 * // Active toggle (override className for active state)
 * <Button {...PANEL_HEADER_TOKENS.actionButton}
 *   className={isActive ? "!bg-fill-2 !text-text-1" : PANEL_HEADER_TOKENS.actionButton.className}
 * />
 * ```
 */
import React, { createContext, memo, useContext } from "react";

import Button from "@src/components/Button";
import { EDITOR_TAB_CANVAS_BG_CLASS } from "@src/config/workstation/tokens";
import { useRefreshSpin } from "@src/hooks/ui";
import {
  ArrowLeft02Icon,
  ArrowRight01Icon,
  HugeiconsIcon,
  type IconSvgElement,
  Refresh04Icon,
  Search01Icon,
} from "@src/icons";

/**
 * Surface background context for nested PanelHeader instances.
 *
 * Lets an ancestor override the default `bg-bg-2` chrome fill for every
 * descendant PanelHeader that does not explicitly set its own `background`
 * prop. Intended for cases where a host already paints a different surface
 * (e.g. the CodeMirror editor canvas used by Workstation content panels),
 * so the header should inherit that surface instead of drawing its own.
 *
 * An explicit `background` prop on a specific PanelHeader still wins.
 */
export type PanelHeaderSurface = "default" | "transparent" | "editorCanvas";

const PanelHeaderSurfaceContext = createContext<PanelHeaderSurface | null>(
  null
);

export const PanelHeaderSurfaceProvider: React.FC<{
  surface: PanelHeaderSurface;
  children: React.ReactNode;
}> = ({ surface, children }) => (
  <PanelHeaderSurfaceContext.Provider value={surface}>
    {children}
  </PanelHeaderSurfaceContext.Provider>
);

// ============================================
// Tokens
// ============================================

/** Standard sizes and button props for PanelHeader elements */
export const PANEL_HEADER_TOKENS = {
  /**
   * Header row layout for custom panel headers (when not using PanelHeader component).
   * Matches the 40px row used by PanelHeader: flex, px-3 (no border — add `border-b border-border-2` if needed).
   */
  row: "flex h-10 flex-shrink-0 items-center gap-2 px-3",

  /** Icon size for title icons (breadcrumb, title prefix) */
  iconSize: 14,
  /** Icon size inside action buttons (slightly larger for tap target) */
  buttonIconSize: 16,
  /** Stroke width for glyph icons in panel header buttons */
  iconStrokeWidth: 1.75,
  /** Font size for title text */
  fontSize: 13,
  /** Header height */
  height: 40,
  /** TabPill size for header-level pill toggles — always small in 40px headers */
  tabPillSize: "small" as const,

  /**
   * Standard props for ALL icon-only action buttons in 40px headers.
   * 24×24 circle, 16px icon, hover shows fill-2 background.
   * Spread on `<Button>`, add `icon`, `onClick`, `title`.
   */
  actionButton: {
    variant: "tertiary" as const,
    size: "mini" as const,
    shape: "circle" as const,
    iconOnly: true as const,
    className: "hover:!bg-fill-2",
  },

  /**
   * Pill-shaped action button (32×24) for dropdown triggers.
   * Use instead of actionButton when the control opens a dropdown (e.g. Add + chevron).
   */
  actionButtonPill: {
    variant: "tertiary" as const,
    size: "mini" as const,
    shape: "round" as const,
    iconOnly: true as const,
    className: "hover:!bg-fill-2 !h-6 !w-9 !min-w-9",
  },

  /**
   * Props for danger action buttons (delete, close).
   * 24×24 circle, 16px icon, hover shows danger-1 background with danger-6 text.
   */
  dangerButton: {
    variant: "tertiary" as const,
    size: "mini" as const,
    shape: "circle" as const,
    iconOnly: true as const,
    className: "hover:!bg-danger-1 hover:!text-danger-6",
  },

  /**
   * Vertical rule between header controls (same as FileHeader tab | actions separator).
   */
  verticalSeparator: "h-4 w-px flex-shrink-0 bg-border-2",
} as const;

// ============================================
// PanelRefreshButton — guaranteed min-spin refresh for panel headers
// ============================================

interface PanelRefreshButtonProps {
  onRefresh: () => void;
  loading: boolean;
  title?: string;
}

/**
 * Standardized refresh button for PanelHeader actions.
 * Uses useRefreshSpin to guarantee a visible 2-round spin even when
 * the refresh resolves instantly, and stays disabled until the spin ends.
 */
export const PanelRefreshButton: React.FC<PanelRefreshButtonProps> = ({
  onRefresh,
  loading,
  title,
}) => {
  const { spinClass, handleClick } = useRefreshSpin(onRefresh, loading);
  return (
    <Button
      {...PANEL_HEADER_TOKENS.actionButton}
      onClick={handleClick}
      disabled={!!spinClass}
      icon={
        <HugeiconsIcon
          icon={Refresh04Icon}
          data-icon="refresh-cw"
          size={PANEL_HEADER_TOKENS.buttonIconSize}
          strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
          className={spinClass}
        />
      }
      title={title}
    />
  );
};

// ============================================
// Types
// ============================================

export interface PanelHeaderBreadcrumb {
  /** Parent label (e.g., "General") */
  parent: string;
  /** Current page label (e.g., "Background") */
  current: string;
  /** Optional icon rendered before current (e.g., provider icon for CLI agent) */
  currentIcon?: React.ReactNode;
}

export interface PanelHeaderProps {
  /** Simple title text */
  title?: string;

  /** Icon glyph (size=14 applied automatically) */
  icon?: IconSvgElement;

  /** Custom icon element for non-glyph icons (use when icon prop doesn't work) */
  iconElement?: React.ReactNode;

  /** Subtitle or secondary text after title */
  subtitle?: string;

  /** Back button click handler - shows back arrow when provided */
  onBack?: () => void;

  /** Breadcrumb navigation (used with onBack) */
  breadcrumb?: PanelHeaderBreadcrumb;

  /** Right-side actions (buttons, etc.) */
  actions?: React.ReactNode;

  /**
   * Search button click handler - shows a search icon button in actions.
   * When clicked, typically opens the PageSearch spotlight selector.
   */
  onSearch?: () => void;

  /**
   * Active search query. When non-empty, overrides the title with the query
   * text and replaces the icon with a Search icon. Pair with `onSearch` to
   * let the user reopen the spotlight and refine the query.
   */
  searchQuery?: string;

  /** Custom children content (overrides title/breadcrumb) */
  children?: React.ReactNode;

  /** Additional className */
  className?: string;

  /** Stable selector for focused layout and interaction tests. */
  dataTestId?: string;

  /** When true, draws a bottom border under the header row (separator against content below). */
  borderBottom?: boolean;

  /**
   * Background style. Default is `bg-bg-2` (panel chrome). Use `transparent` when the parent
   * already fills with the intended surface (e.g. editor canvas). `editorCanvas` paints the
   * same as CodeMirror chrome when there is no solid parent behind the header row.
   *
   * When omitted, the header falls back to the nearest `PanelHeaderSurfaceProvider`
   * above it (if any) before defaulting to `"default"`.
   */
  background?: PanelHeaderSurface;

  /** Header variant - "list" uses px-3 padding; `borderBottom` is ignored (no border) */
  variant?: "default" | "list";

  /**
   * Content rendered below the main header row (e.g. InternalHeader with tabs).
   * When provided, no extra padding-top is needed on the scroll content below.
   */
  afterHeader?: React.ReactNode;
}

// ============================================
// Component
// ============================================

const PanelHeader: React.FC<PanelHeaderProps> = memo(
  ({
    title,
    icon,
    iconElement,
    subtitle,
    onBack,
    breadcrumb,
    actions,
    onSearch,
    searchQuery,
    children,
    className = "",
    dataTestId,
    borderBottom = false,
    background,
    variant = "default",
    afterHeader,
  }) => {
    // When searchQuery is active, override title/icon to show search state
    const displayTitle = searchQuery ? searchQuery : title;
    const displayIcon = searchQuery ? Search01Icon : icon;
    const displayIconElement = searchQuery ? undefined : iconElement;
    const isListVariant = variant === "list";
    const paddingClass = isListVariant ? "px-3" : "px-4";
    const baseClasses = `relative z-30 flex h-10 flex-shrink-0 items-center gap-2 ${paddingClass}`;
    const borderClasses =
      borderBottom && !isListVariant ? "border-b border-border-2" : "";
    const contextSurface = useContext(PanelHeaderSurfaceContext);
    const resolvedBackground: PanelHeaderSurface =
      background ?? contextSurface ?? "default";
    const bgClasses =
      resolvedBackground === "transparent"
        ? ""
        : resolvedBackground === "editorCanvas"
          ? EDITOR_TAB_CANVAS_BG_CLASS
          : "bg-bg-2";

    // Render custom content or default title/breadcrumb
    const renderContent = () => {
      // Children override everything
      if (children) {
        return children;
      }

      // Breadcrumb mode
      if (breadcrumb) {
        return (
          <>
            {displayIconElement && (
              <span className="flex-shrink-0 text-text-2">
                {displayIconElement}
              </span>
            )}
            <span
              className="text-text-2"
              style={{ fontSize: PANEL_HEADER_TOKENS.fontSize }}
            >
              {breadcrumb.parent}
            </span>
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              data-icon="chevron-right"
              size={PANEL_HEADER_TOKENS.iconSize}
              className="flex-shrink-0 text-text-4"
            />
            {breadcrumb.currentIcon && (
              <span className="flex-shrink-0 text-text-2">
                {breadcrumb.currentIcon}
              </span>
            )}
            <span
              className="truncate font-medium text-text-1"
              style={{ fontSize: PANEL_HEADER_TOKENS.fontSize }}
            >
              {breadcrumb.current}
            </span>
          </>
        );
      }

      // Title mode (uses display* vars which respect searchQuery override)
      const IconComponent = displayIcon;
      return (
        <>
          {displayIconElement && (
            <span className="flex-shrink-0 text-text-2">
              {displayIconElement}
            </span>
          )}
          {!displayIconElement && IconComponent && (
            <HugeiconsIcon
              icon={IconComponent}
              size={PANEL_HEADER_TOKENS.iconSize}
              className="flex-shrink-0 text-text-2"
            />
          )}
          {displayTitle && (
            <span
              className="truncate font-medium text-text-1"
              style={{ fontSize: PANEL_HEADER_TOKENS.fontSize }}
            >
              {displayTitle}
            </span>
          )}
          {!searchQuery && subtitle && (
            <>
              <span className="text-text-4">/</span>
              <span
                className="truncate text-text-2"
                style={{ fontSize: PANEL_HEADER_TOKENS.fontSize }}
              >
                {subtitle}
              </span>
            </>
          )}
        </>
      );
    };

    const headerRow = (
      <div
        className={`${baseClasses} ${borderClasses} ${bgClasses} ${className}`}
        data-testid={dataTestId}
      >
        {/* Back button */}
        {onBack && (
          <Button
            {...PANEL_HEADER_TOKENS.actionButton}
            icon={
              <HugeiconsIcon
                icon={ArrowLeft02Icon}
                data-icon="arrow-left"
                size={PANEL_HEADER_TOKENS.buttonIconSize}
                strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
              />
            }
            onClick={onBack}
            title="Back"
          />
        )}

        {/* Content - flex-1 to push actions to right */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {renderContent()}
        </div>

        {/* Right-side actions */}
        {(actions || onSearch) && (
          <div className="flex flex-shrink-0 items-center gap-2">
            {onSearch && (
              <Button
                {...PANEL_HEADER_TOKENS.actionButton}
                icon={
                  <HugeiconsIcon
                    icon={Search01Icon}
                    data-icon="search"
                    size={PANEL_HEADER_TOKENS.buttonIconSize}
                    strokeWidth={PANEL_HEADER_TOKENS.iconStrokeWidth}
                  />
                }
                onClick={onSearch}
                title="Search pages"
              />
            )}
            {actions}
          </div>
        )}
      </div>
    );

    if (afterHeader) {
      return (
        <div className="flex flex-shrink-0 flex-col">
          {headerRow}
          {afterHeader}
        </div>
      );
    }

    return headerRow;
  }
);

PanelHeader.displayName = "PanelHeader";

export default PanelHeader;
