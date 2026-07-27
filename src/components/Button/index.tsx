/**
 * Button Component (Native Implementation)
 *
 * Two orthogonal axes describe a button's look:
 *
 *   variant     — importance / semantic role
 *                 "primary"   = call-to-action / brand color
 *                 "secondary" = regular action
 *                 "tertiary"  = supporting / inline action
 *                 "danger"    = destructive
 *                 "warning"   = caution-required
 *                 "success"   = positive confirmation
 *
 *   appearance  — visual treatment
 *                 "solid"   = filled background
 *                 "outline" = bordered, transparent fill
 *                 "dashed"  = dashed border (typically for add/upload)
 *                 "ghost"   = no border, no background — hover changes
 *                            only the text color
 *
 * @example
 * ```tsx
 * import Button from "@src/components/Button";
 *
 * <Button variant="primary">Submit</Button>
 * <Button variant="secondary" size="small">Cancel</Button>
 * <Button variant="danger" appearance="ghost">Remove</Button>
 * <Button variant="tertiary" appearance="ghost">Inline action</Button>
 * <Button loading>Loading...</Button>
 * <Button variant="primary" icon={<Plus size={14} />}>Add</Button>
 * ```
 */
import { ChevronDown, Loader2 } from "lucide-react";
import React, { forwardRef, useMemo } from "react";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "tertiary"
  | "danger"
  | "warning"
  | "success";

export type ButtonAppearance = "solid" | "outline" | "dashed" | "ghost";

export interface ButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "type"
> {
  /**
   * Importance / semantic role.
   * @default "secondary"
   */
  variant?: ButtonVariant;

  /**
   * Visual treatment.
   * @default depends on variant — "solid" for primary/danger/warning/success,
   *          "outline" for secondary, "solid" for tertiary
   */
  appearance?: ButtonAppearance;

  /**
   * Button size
   * @default "default"
   */
  size?: "mini" | "small" | "default" | "large";

  /**
   * Button shape
   * @default "square"
   */
  shape?: "square" | "round" | "circle";

  /** Loading state @default false */
  loading?: boolean;

  /**
   * When true and loading, spin the provided icon in place instead of
   * replacing it with the Loader2 spinner.
   * @default false
   */
  loadingSpinIcon?: boolean;

  /** Disabled state @default false */
  disabled?: boolean;

  /**
   * Icon element (left side by default)
   * Can be a React node or a string (icon class name like "ri-home-line")
   */
  icon?: React.ReactNode | string;

  /** Icon position @default "left" */
  iconPosition?: "left" | "right";

  /** Icon-only button (no text) @default false */
  iconOnly?: boolean;

  /** Button takes full width @default false */
  long?: boolean;

  /** HTML button type @default "button" */
  htmlType?: "button" | "submit" | "reset";

  /** Button href (renders as anchor) */
  href?: string;

  /** Anchor target */
  target?: string;

  /** Anchor relationship */
  rel?: string;

  /** Children content */
  children?: React.ReactNode;

  /** Dropdown menu for split button (VSCode style) */
  dropdownMenu?: React.ReactNode;

  /** Callback when dropdown arrow is clicked */
  onDropdownClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;

  /** Whether the dropdown is visible (for split button) */
  dropdownVisible?: boolean;

  /** Optional main segment width for icon-only split buttons. */
  splitIconOnlyMainWidth?: number;

  /**
   * Optional width (px) of the split-button dropdown caret segment. Overrides
   * the default (`height / 2` for icon-only, `height` otherwise).
   */
  splitDropdownWidth?: number;

  /** Align split-button content within the main segment or the full button. */
  splitContentAlign?: "main" | "button";

  /** Whether split buttons should fill the parent width or hug their content. */
  splitWidthMode?: "fill" | "hug";
}

const SIZE_CONFIG = {
  mini: { height: 24, padding: "0 8px", fontSize: 12, iconSize: 12 },
  small: { height: 28, padding: "0 12px", fontSize: 13, iconSize: 14 },
  default: { height: 32, padding: "0 14px", fontSize: 13, iconSize: 14 },
  large: { height: 40, padding: "0 18px", fontSize: 14, iconSize: 16 },
} as const;

function defaultAppearanceFor(variant: ButtonVariant): ButtonAppearance {
  switch (variant) {
    case "primary":
    case "danger":
    case "warning":
    case "success":
      return "solid";
    case "secondary":
      return "outline";
    case "tertiary":
      return "solid";
  }
}

/**
 * Static Tailwind class strings for each (variant, appearance) cell.
 * Class strings must be statically analyzable — no dynamic interpolation
 * of class names, only dynamic selection between fully-written strings.
 */
function getStyleClasses(variant: ButtonVariant, appearance: ButtonAppearance) {
  const base = (() => {
    switch (variant) {
      case "primary":
        if (appearance === "solid") return "border-0 text-white bg-primary-6";
        if (appearance === "outline")
          return "border border-primary-6 bg-transparent text-primary-6";
        if (appearance === "dashed")
          return "border border-dashed border-primary-6/50 bg-transparent text-primary-6";
        return "border-0 bg-transparent text-primary-6";
      case "secondary":
        if (appearance === "solid") return "border-0 bg-fill-2 text-text-1";
        if (appearance === "outline")
          return "border border-border-2 bg-bg-2 text-text-1";
        if (appearance === "dashed")
          return "border border-dashed border-border-2 bg-transparent text-text-1";
        return "border-0 bg-transparent text-text-1";
      case "tertiary":
        if (appearance === "solid")
          return "border-0 bg-transparent text-text-2";
        if (appearance === "outline")
          return "border border-border-2 bg-bg-2 text-text-2";
        if (appearance === "dashed")
          return "border border-dashed border-border-2 bg-transparent text-text-2";
        return "border-0 bg-transparent text-text-2";
      case "danger":
        if (appearance === "solid") return "border-0 text-white bg-danger-6";
        if (appearance === "outline")
          return "border border-border-2 bg-bg-2 text-danger-6";
        if (appearance === "dashed")
          return "border border-dashed border-danger-6/50 bg-transparent text-danger-6";
        return "border-0 bg-transparent text-danger-6";
      case "warning":
        if (appearance === "solid") return "border-0 text-white bg-warning-6";
        if (appearance === "outline")
          return "border border-border-2 bg-bg-2 text-warning-6";
        if (appearance === "dashed")
          return "border border-dashed border-warning-6/50 bg-transparent text-warning-6";
        return "border-0 bg-transparent text-warning-6";
      case "success":
        if (appearance === "solid") return "border-0 text-white bg-success-6";
        if (appearance === "outline")
          return "border border-border-2 bg-bg-2 text-success-6";
        if (appearance === "dashed")
          return "border border-dashed border-success-6/50 bg-transparent text-success-6";
        return "border-0 bg-transparent text-success-6";
    }
  })();

  const hover = (() => {
    if (appearance === "solid") {
      switch (variant) {
        case "primary":
          return "enabled:hover:bg-primary-5 enabled:active:bg-primary-7";
        case "danger":
          return "enabled:hover:bg-danger-5 enabled:active:bg-danger-6";
        case "warning":
          return "enabled:hover:bg-warning-5 enabled:active:bg-warning-6";
        case "success":
          return "enabled:hover:bg-success-5 enabled:active:bg-success-6";
        case "secondary":
          return "enabled:hover:bg-fill-3";
        case "tertiary":
          return "enabled:hover:text-text-1 enabled:hover:bg-surface-hover focus-visible:text-text-1 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]";
      }
    }
    if (appearance === "outline" || appearance === "dashed") {
      // Bordered variants: tint the border on hover for the neutral
      // greys, and for colored ones we keep the existing focus ring.
      if (variant === "secondary" || variant === "tertiary") {
        return "hover:border-border-3 focus-visible:border-[var(--color-primary-6)] focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]";
      }
      return "";
    }
    // appearance === "ghost"
    switch (variant) {
      case "primary":
        return "enabled:hover:text-primary-5";
      case "danger":
        return "enabled:hover:text-danger-5";
      case "warning":
        return "enabled:hover:text-warning-5";
      case "success":
        return "enabled:hover:text-success-5";
      case "secondary":
        return "enabled:hover:text-text-1";
      case "tertiary":
        return "enabled:hover:text-text-1";
    }
  })();

  return [base, hover].filter(Boolean).join(" ");
}

const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "secondary",
      appearance,
      size = "default",
      shape = "square",
      loading = false,
      loadingSpinIcon = false,
      disabled = false,
      icon,
      iconPosition = "left",
      iconOnly = false,
      long = false,
      htmlType = "button",
      href,
      target,
      rel,
      children,
      className = "",
      style,
      onClick,
      dropdownMenu,
      onDropdownClick,
      dropdownVisible,
      splitIconOnlyMainWidth,
      splitDropdownWidth,
      splitContentAlign = "main",
      splitWidthMode = "fill",
      ...rest
    },
    ref
  ) => {
    const sizeConfig = SIZE_CONFIG[size];
    const isDisabled = disabled || loading;
    const hasSplitButton = dropdownMenu && onDropdownClick;
    const resolvedAppearance = appearance ?? defaultAppearanceFor(variant);

    const borderRadius = useMemo(() => {
      if (shape === "circle") return "50%";
      if (shape === "round") return "100px";
      return "8px";
    }, [shape]);

    const buttonStyles = useMemo<React.CSSProperties>(() => {
      const iconOnlySize =
        iconOnly || shape === "circle" ? sizeConfig.height : undefined;
      return {
        height: sizeConfig.height,
        padding: iconOnly || shape === "circle" ? "0" : sizeConfig.padding,
        width: long ? "100%" : iconOnlySize,
        minWidth: long ? 0 : undefined,
        fontSize: sizeConfig.fontSize,
        borderRadius,
        ...style,
      };
    }, [sizeConfig, iconOnly, shape, long, borderRadius, style]);

    // Icon↔label spacing lives on the icon itself (margin), NOT on a flex
    // `gap` of the <button>: WebKit's button-internal (anonymous-box) layout
    // can drop the gap, which rendered the loading spinner flush against /
    // overlapping the label (e.g. the "Verify setup" button while verifying).
    const iconSpacingClass =
      children && !iconOnly ? (iconPosition === "right" ? "ml-2" : "mr-2") : "";

    const renderIcon = () => {
      if (loading) {
        if (loadingSpinIcon && icon) {
          return (
            <span
              className={`pointer-events-none inline-flex shrink-0 animate-spin items-center justify-center leading-none ${iconSpacingClass}`}
            >
              {icon}
            </span>
          );
        }
        // Wrapped in a span (like the icon branches): WKWebView's
        // button-internal layout can drop margins set directly on the svg,
        // which rendered the spinner on top of the label.
        return (
          <span
            className={`pointer-events-none inline-flex shrink-0 items-center justify-center leading-none ${iconSpacingClass}`}
          >
            <Loader2 size={sizeConfig.iconSize} className="animate-spin" />
          </span>
        );
      }
      if (icon) {
        if (typeof icon === "string") {
          return (
            <i
              className={`${icon} inline-flex shrink-0 items-center justify-center leading-none ${iconSpacingClass}`}
              style={{ fontSize: sizeConfig.iconSize }}
            />
          );
        }
        return (
          <span
            className={`pointer-events-none inline-flex shrink-0 items-center justify-center leading-none ${iconSpacingClass}`}
          >
            {icon}
          </span>
        );
      }
      return null;
    };

    const buttonContent = (
      <>
        {iconPosition === "left" && renderIcon()}
        {!iconOnly && (
          <span className="min-w-0 truncate leading-tight">{children}</span>
        )}
        {iconPosition === "right" && renderIcon()}
      </>
    );

    const baseClasses =
      "inline-flex items-center justify-center font-medium whitespace-nowrap select-none no-underline outline-none transition-[border-color,box-shadow,background-color,color,opacity] duration-150";
    const disabledClasses = isDisabled
      ? "cursor-not-allowed opacity-50"
      : "cursor-pointer";

    const splitWrapperHoverClass =
      !isDisabled && variant === "tertiary" && resolvedAppearance === "solid"
        ? "group-hover/button-split:bg-surface-hover group-hover/button-split:text-text-1"
        : "";

    const splitDropdownColorClass = (() => {
      if (resolvedAppearance === "solid") {
        switch (variant) {
          case "primary":
          case "danger":
          case "warning":
          case "success":
            return "text-white";
          case "secondary":
            return "text-text-1";
          case "tertiary":
            return "text-text-2 group-hover/button-split:text-text-1";
        }
      }
      switch (variant) {
        case "primary":
          return "text-primary-6";
        case "danger":
          return "text-danger-6";
        case "warning":
          return "text-warning-6";
        case "success":
          return "text-success-6";
        case "secondary":
          return "text-text-1";
        case "tertiary":
          return "text-text-2 group-hover/button-split:text-text-1";
      }
    })();

    const splitDropdownStateClass = (() => {
      if (isDisabled) return "";
      if (resolvedAppearance === "solid" && variant === "primary") {
        return dropdownVisible
          ? "bg-primary-5 enabled:hover:bg-primary-5"
          : "enabled:hover:bg-primary-5";
      }
      return "enabled:hover:bg-fill-3";
    })();

    const buttonClassName = [
      "button",
      baseClasses,
      disabledClasses,
      getStyleClasses(variant, resolvedAppearance),
      className,
    ]
      .filter(Boolean)
      .join(" ");

    if (href && !isDisabled) {
      return (
        <a
          href={href}
          target={target}
          rel={rel}
          className={buttonClassName}
          style={buttonStyles}
          onClick={
            onClick as unknown as React.MouseEventHandler<HTMLAnchorElement>
          }
          {...(rest as unknown as React.AnchorHTMLAttributes<HTMLAnchorElement>)}
        >
          {buttonContent}
        </a>
      );
    }

    if (hasSplitButton) {
      const dropdownWidth =
        splitDropdownWidth ??
        (iconOnly ? sizeConfig.height / 2 : sizeConfig.height);
      const splitMainWidth = iconOnly
        ? (splitIconOnlyMainWidth ?? sizeConfig.height)
        : undefined;
      const splitButtonWidth = iconOnly
        ? (splitMainWidth ?? sizeConfig.height) + dropdownWidth
        : undefined;
      const shouldHugSplit = splitWidthMode === "hug" && !iconOnly && !long;

      return (
        <div
          className="button-split-wrapper group/button-split"
          style={{
            display: "flex",
            position: "relative",
            width: long ? "100%" : "auto",
            minWidth: 0,
          }}
        >
          <div
            style={{
              position: "relative",
              flex: shouldHugSplit ? "none" : 1,
              display: "flex",
              minWidth: 0,
            }}
          >
            <button
              ref={ref}
              type={htmlType}
              disabled={isDisabled}
              className={`${buttonClassName} ${splitWrapperHoverClass}`.trim()}
              style={{
                ...buttonStyles,
                width: shouldHugSplit ? "auto" : (splitButtonWidth ?? "100%"),
                minWidth: 0,
                flex: iconOnly || shouldHugSplit ? "none" : 1,
                paddingRight: iconOnly ? 0 : `${dropdownWidth}px`,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                position: "relative",
              }}
              onClick={onClick}
              {...rest}
            >
              {shouldHugSplit ? (
                buttonContent
              ) : (
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    right: splitContentAlign === "button" ? 0 : dropdownWidth,
                    top: 0,
                    bottom: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    // Icon↔label spacing comes from the icon margin (see
                    // iconSpacingClass) — no flex gap needed here either.
                    pointerEvents: "none",
                  }}
                >
                  {buttonContent}
                </div>
              )}
            </button>

            <button
              type="button"
              disabled={isDisabled}
              className={`transition-colors ${splitDropdownStateClass} ${splitDropdownColorClass}`}
              style={{
                position: "absolute",
                right: 0,
                top: 0,
                bottom: 0,
                width: dropdownWidth,
                height: "100%",
                padding: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "none",
                borderTopRightRadius: borderRadius,
                borderBottomRightRadius: borderRadius,
                cursor: isDisabled
                  ? "not-allowed"
                  : "var(--interactive-cursor, default)",
                opacity: isDisabled ? 0.5 : 1,
              }}
              onClick={onDropdownClick}
            >
              <ChevronDown size={12} />
            </button>
          </div>

          {dropdownVisible && dropdownMenu}
        </div>
      );
    }

    return (
      <button
        ref={ref}
        type={htmlType}
        disabled={isDisabled}
        className={buttonClassName}
        style={buttonStyles}
        onClick={onClick}
        {...rest}
      >
        {buttonContent}
      </button>
    );
  }
);

Button.displayName = "Button";

export default Button;
