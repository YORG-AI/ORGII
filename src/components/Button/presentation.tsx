import React, { useMemo } from "react";

import { HugeiconsIcon, Loading03Icon } from "@src/icons";

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "tertiary"
  | "danger"
  | "warning"
  | "success"
  | "merged";

export type ButtonAppearance = "solid" | "outline" | "dashed" | "ghost";
export type ButtonSize = "mini" | "small" | "default" | "large";
export type ButtonShape = "square" | "round" | "circle";

const BUTTON_SIZE_CONFIG = {
  mini: { height: 24, padding: "0 8px", fontSize: 12, iconSize: 12 },
  small: { height: 28, padding: "0 12px", fontSize: 13, iconSize: 14 },
  default: { height: 32, padding: "0 14px", fontSize: 13, iconSize: 14 },
  large: { height: 40, padding: "0 18px", fontSize: 14, iconSize: 16 },
} as const;

function defaultButtonAppearance(variant: ButtonVariant): ButtonAppearance {
  switch (variant) {
    case "primary":
    case "danger":
    case "warning":
    case "success":
    case "merged":
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
function getButtonStyleClasses(
  variant: ButtonVariant,
  appearance: ButtonAppearance
) {
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
          return "border border-dashed border-border-2 bg-transparent text-warning-6";
        return "border-0 bg-transparent text-warning-6";
      case "success":
        if (appearance === "solid") return "border-0 text-white bg-success-6";
        if (appearance === "outline")
          return "border border-border-2 bg-bg-2 text-success-6";
        if (appearance === "dashed")
          return "border border-dashed border-success-6/50 bg-transparent text-success-6";
        return "border-0 bg-transparent text-success-6";
      case "merged":
        if (appearance === "solid")
          return "border-0 bg-merged text-merged-contrast";
        if (appearance === "outline")
          return "border border-purple-6 bg-transparent text-purple-6";
        if (appearance === "dashed")
          return "border border-dashed border-purple-6/50 bg-transparent text-purple-6";
        return "border-0 bg-transparent text-purple-6";
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
        case "merged":
          return "enabled:hover:bg-merged-hover enabled:active:bg-merged-active";
        case "secondary":
          return "enabled:hover:bg-fill-3";
        case "tertiary":
          return "enabled:hover:text-text-1 enabled:hover:bg-surface-hover enabled:active:bg-surface-selected focus-visible:text-text-1 focus-visible:outline-none focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]";
      }
    }
    if (appearance === "outline" || appearance === "dashed") {
      if (variant === "secondary" || variant === "tertiary") {
        return "hover:border-border-3 focus-visible:border-[var(--color-primary-6)] focus-visible:shadow-[0_0_0_2px_color-mix(in_srgb,var(--color-primary-6)_15%,transparent)]";
      }
      return "";
    }
    switch (variant) {
      case "primary":
        return "enabled:hover:text-primary-5";
      case "danger":
        return "enabled:hover:text-danger-5";
      case "warning":
        return "enabled:hover:text-warning-5";
      case "success":
        return "enabled:hover:text-success-5";
      case "merged":
        return "enabled:hover:text-purple-5";
      case "secondary":
      case "tertiary":
        return "enabled:hover:text-text-1";
    }
  })();

  return [base, hover].filter(Boolean).join(" ");
}

interface ButtonPresentationOptions {
  variant: ButtonVariant;
  appearance?: ButtonAppearance;
  size: ButtonSize;
  shape: ButtonShape;
  loading: boolean;
  loadingSpinIcon: boolean;
  disabled: boolean;
  icon?: React.ReactNode | string;
  iconPosition: "left" | "right";
  iconOnly: boolean;
  centerLabel: boolean;
  long: boolean;
  children?: React.ReactNode;
  className: string;
  style?: React.CSSProperties;
}

export function useButtonPresentation({
  variant,
  appearance,
  size,
  shape,
  loading,
  loadingSpinIcon,
  disabled,
  icon,
  iconPosition,
  iconOnly,
  centerLabel,
  long,
  children,
  className,
  style,
}: ButtonPresentationOptions) {
  const sizeConfig = BUTTON_SIZE_CONFIG[size];
  const isDisabled = disabled || loading;
  const resolvedAppearance = appearance ?? defaultButtonAppearance(variant);

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
      return (
        <span
          className={`pointer-events-none inline-flex shrink-0 items-center justify-center leading-none ${iconSpacingClass}`}
        >
          <HugeiconsIcon
            icon={Loading03Icon}
            data-icon="loader-2"
            size={sizeConfig.iconSize}
            className="animate-spin"
          />
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

  const iconNode = renderIcon();
  const label = iconOnly ? null : (
    <span className="min-w-0 truncate leading-tight">{children}</span>
  );

  // `centerLabel` pulls the icon out of flow so the label alone sits on the
  // button's horizontal center. Centering icon + label as one group leaves the
  // label reading off-center, which is visible on full-width action buttons.
  const buttonContent =
    centerLabel && label && iconNode ? (
      <span className="relative inline-flex min-w-0 items-center justify-center">
        <span
          className={`absolute inset-y-0 inline-flex items-center ${
            iconPosition === "right" ? "left-full" : "right-full"
          }`}
        >
          {iconNode}
        </span>
        {label}
      </span>
    ) : (
      <>
        {iconPosition === "left" && iconNode}
        {label}
        {iconPosition === "right" && iconNode}
      </>
    );

  const baseClasses =
    "inline-flex items-center justify-center font-medium whitespace-nowrap select-none no-underline outline-none transition-[border-color,box-shadow,background-color,color,opacity] duration-150";
  const disabledClasses = isDisabled
    ? "cursor-not-allowed opacity-50"
    : "cursor-pointer";
  const buttonClassName = [
    "button",
    baseClasses,
    disabledClasses,
    getButtonStyleClasses(variant, resolvedAppearance),
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    sizeConfig,
    isDisabled,
    resolvedAppearance,
    borderRadius,
    buttonStyles,
    buttonContent,
    buttonClassName,
  };
}
