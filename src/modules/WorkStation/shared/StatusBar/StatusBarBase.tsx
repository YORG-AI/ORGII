/**
 * BaseStatusBar Component
 *
 * Shared base component for status bars across Workstation apps.
 * Provides consistent styling and layout structure.
 *
 * Used by:
 * - EditorStatusBar (CodeEditor)
 * - DatabaseStatusBar (Database Manager)
 * - BrowserStatusBar (Browser)
 * - ProjectStatusBar (Project Manager)
 *
 * Layout:
 * ┌────────────────────────────────────────────────┐
 * │ [Left Content]  [Center Content]  [Right Content] │
 * └────────────────────────────────────────────────┘
 */
import React, { forwardRef, memo } from "react";

import type { ButtonVariant } from "@src/components/Button";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { classNames } from "@src/util/ui/classNames";

import { STATUS_BAR_TOKENS, STATUS_BAR_TYPOGRAPHY } from "./statusBarTokens";

// ============================================
// Types
// ============================================

export interface BaseStatusBarProps {
  /** Content for the left section */
  leftContent?: React.ReactNode;
  /** Content for the center section (optional, absolute positioned) */
  centerContent?: React.ReactNode;
  /** Content for the right section */
  rightContent?: React.ReactNode;
  /** Whether to use rounded bottom corners (for simulator frame) */
  roundedBottom?: boolean;
  /** Additional class name */
  className?: string;
}

// ============================================
// Sub-components for composition
// ============================================

/**
 * Semantic importance for {@link StatusBarButton}. The status-bar treatment
 * is ghost by default; `primary` opts into the brand-filled call-to-action.
 */
export type StatusBarButtonVariant = Extract<
  ButtonVariant,
  "primary" | "tertiary"
>;

export interface StatusBarButtonProps {
  /** Button content */
  children: React.ReactNode;
  /** Click handler */
  onClick?: () => void;
  /** Whether the button is disabled */
  disabled?: boolean;
  /**
   * Native `title` tooltip. Prefer wrapping the button in the app `Tooltip`
   * (see {@link ariaLabel}) for a styled hover tooltip instead of the
   * browser's native one.
   */
  title?: string;
  /**
   * Accessible name. Use this instead of `title` when a styled app `Tooltip`
   * supplies the visible hover label — the button stays screen-reader
   * labelled without the browser also rendering its native tooltip.
   */
  ariaLabel?: string;
  /** Whether the button is active/selected (tertiary only) */
  active?: boolean;
  /** Semantic importance — see {@link StatusBarButtonVariant} */
  variant?: StatusBarButtonVariant;
  /** Additional class name */
  className?: string;
  dataTestId?: string;
  /**
   * Hover/focus handlers, forwarded to the underlying `<button>`. These let an
   * app `Tooltip` wrap the button directly (it clones the child and attaches
   * these) without an extra element that would break the flex truncation.
   */
  onMouseEnter?: React.MouseEventHandler<HTMLButtonElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLButtonElement>;
  onFocus?: React.FocusEventHandler<HTMLButtonElement>;
  onBlur?: React.FocusEventHandler<HTMLButtonElement>;
}

/**
 * Styled button for use within status bars.
 */
export const StatusBarButton = memo(
  forwardRef<HTMLButtonElement, StatusBarButtonProps>(
    (
      {
        children,
        onClick,
        disabled = false,
        title,
        ariaLabel,
        active = false,
        variant = "tertiary",
        className,
        dataTestId,
        onMouseEnter,
        onMouseLeave,
        onFocus,
        onBlur,
      },
      ref
    ) => {
      // `active` only applies to the tertiary variant — the primary fill
      // already reads as a pressed CTA, so adding bg-fill-2 on top would
      // mute the brand color.
      const activeClass =
        variant === "tertiary" && active ? SURFACE_TOKENS.selected : "";
      const variantClass =
        variant === "primary"
          ? STATUS_BAR_TOKENS.buttonPrimary
          : STATUS_BAR_TOKENS.buttonGhost;

      return (
        <button
          ref={ref}
          type="button"
          className={classNames(
            STATUS_BAR_TOKENS.button,
            variantClass,
            activeClass,
            disabled && "cursor-not-allowed opacity-50",
            className
          )}
          onClick={onClick}
          onMouseEnter={onMouseEnter}
          onMouseLeave={onMouseLeave}
          onFocus={onFocus}
          onBlur={onBlur}
          disabled={disabled}
          title={title}
          aria-label={ariaLabel ?? title}
          data-testid={dataTestId}
        >
          {children}
        </button>
      );
    }
  )
);

StatusBarButton.displayName = "StatusBarButton";

/**
 * Non-interactive row matching {@link StatusBarButton} padding and height (icon + label groups).
 */
export interface StatusBarSegmentProps {
  children: React.ReactNode;
  /** Native tooltip */
  title?: string;
  className?: string;
}

export const StatusBarSegment: React.FC<StatusBarSegmentProps> = memo(
  ({ children, title, className }) => (
    <div
      className={classNames(STATUS_BAR_TOKENS.segment, className)}
      title={title}
    >
      {children}
    </div>
  )
);

StatusBarSegment.displayName = "StatusBarSegment";

export interface StatusBarLabelProps {
  children: React.ReactNode;
  /** Use the status bar's emphasized label weight. */
  emphasis?: boolean;
  /** Use stable-width numerals for changing counts and positions. */
  numeric?: boolean;
  className?: string;
}

/**
 * Inline typography primitive for labels nested inside status-bar buttons and
 * segments. Font size and line height come from the bar root; this component
 * owns only the semantic weight and numeric alignment variants.
 */
export const StatusBarLabel: React.FC<StatusBarLabelProps> = memo(
  ({ children, emphasis = false, numeric = false, className }) => (
    <span
      className={classNames(
        emphasis ? STATUS_BAR_TYPOGRAPHY.emphasis : STATUS_BAR_TYPOGRAPHY.label,
        numeric && STATUS_BAR_TYPOGRAPHY.numeric,
        className
      )}
    >
      {children}
    </span>
  )
);

StatusBarLabel.displayName = "StatusBarLabel";

export interface StatusBarTextProps {
  /** Text content */
  children: React.ReactNode;
  /** Whether text should be muted */
  muted?: boolean;
  /** Use the status bar's emphasized label weight. */
  emphasis?: boolean;
  /** Use stable-width numerals for changing counts and positions. */
  numeric?: boolean;
  /** Native tooltip — useful for truncated labels */
  title?: string;
  /** Additional class name */
  className?: string;
}

/**
 * Plain text segment — same horizontal padding and height alignment as {@link StatusBarButton}.
 */
export const StatusBarText: React.FC<StatusBarTextProps> = memo(
  ({
    children,
    muted = false,
    emphasis = false,
    numeric = false,
    title,
    className,
  }) => {
    return (
      <span
        className={classNames(
          STATUS_BAR_TOKENS.text,
          emphasis
            ? STATUS_BAR_TYPOGRAPHY.emphasis
            : STATUS_BAR_TYPOGRAPHY.label,
          numeric && STATUS_BAR_TYPOGRAPHY.numeric,
          muted ? "text-text-3" : "text-text-1",
          className
        )}
        title={title}
      >
        {children}
      </span>
    );
  }
);

StatusBarText.displayName = "StatusBarText";

export interface StatusBarDividerProps {
  /** Additional class name */
  className?: string;
}

/**
 * Visual divider between status bar sections.
 */
export const StatusBarDivider: React.FC<StatusBarDividerProps> = memo(
  ({ className }) => {
    return <span className={classNames("text-text-3", className)}>·</span>;
  }
);

StatusBarDivider.displayName = "StatusBarDivider";

// ============================================
// Main Component
// ============================================

export const BaseStatusBar: React.FC<BaseStatusBarProps> = memo(
  ({
    leftContent,
    centerContent,
    rightContent,
    roundedBottom = false,
    className,
  }) => {
    return (
      <div
        className={classNames(
          STATUS_BAR_TOKENS.barShell,
          STATUS_BAR_TOKENS.heightClass,
          STATUS_BAR_TOKENS.typographyClass,
          STATUS_BAR_TOKENS.barPaddingClass,
          // Top hairline = boundary with the content area above. The
          // bottom hairline (boundary with the dock) is owned by
          // `StationDockChrome` so every consumer renders the same line
          // at the same DOM depth — see comment in StationDockChrome.
          "border-t border-border-2 text-text-1",
          roundedBottom && "rounded-b-page",
          className
        )}
      >
        {/* Left section */}
        <div className={STATUS_BAR_TOKENS.leftCluster}>{leftContent}</div>

        {/* Center section (absolute positioned) */}
        {centerContent && (
          <div className={STATUS_BAR_TOKENS.centerCluster}>{centerContent}</div>
        )}

        {/* Right section */}
        <div className={STATUS_BAR_TOKENS.rightCluster}>{rightContent}</div>
      </div>
    );
  }
);

BaseStatusBar.displayName = "BaseStatusBar";

export default BaseStatusBar;
