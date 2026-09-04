import React, { forwardRef } from "react";

import type { ButtonProps } from "@src/components/Button";
import { useButtonPresentation } from "@src/components/Button/presentation";
import { ArrowDown01Icon, HugeiconsIcon } from "@src/icons";

interface SplitButtonProps extends Omit<
  ButtonProps,
  "href" | "target" | "rel" | "aria-expanded" | "aria-haspopup"
> {
  /** Menu anchor or portal rendered while the menu is open. */
  menu: React.ReactNode;

  /** Controlled menu visibility. */
  menuOpen: boolean;

  /** Activates the menu segment. */
  onMenuButtonClick: React.MouseEventHandler<HTMLButtonElement>;

  /** Accessible name for the menu segment. */
  menuButtonLabel: string;

  /** Optional main-segment width for icon-only split buttons. */
  mainSegmentWidth?: number;

  /**
   * Optional menu-segment width in pixels. Defaults to half the button height
   * for icon-only buttons and the full button height otherwise.
   */
  menuSegmentWidth?: number;

  /** Centers content within the main segment or the whole split control. */
  contentAlignment?: "main" | "whole";

  /** Whether a labelled split button fills its parent or hugs its content. */
  widthMode?: "fill" | "hug";
}

const SplitButton = forwardRef<HTMLButtonElement, SplitButtonProps>(
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
      centerLabel = false,
      long = false,
      htmlType = "button",
      children,
      className = "",
      style,
      onClick,
      menu,
      menuOpen,
      onMenuButtonClick,
      menuButtonLabel,
      mainSegmentWidth,
      menuSegmentWidth,
      contentAlignment = "main",
      widthMode = "fill",
      ...rest
    },
    ref
  ) => {
    const {
      sizeConfig,
      isDisabled,
      resolvedAppearance,
      borderRadius,
      buttonStyles,
      buttonContent,
      buttonClassName,
    } = useButtonPresentation({
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
    });

    const wrapperHoverClass =
      !isDisabled && variant === "tertiary" && resolvedAppearance === "solid"
        ? "group-hover/button-split:bg-surface-hover group-hover/button-split:text-text-1"
        : "";

    const menuColorClass = (() => {
      if (resolvedAppearance === "solid") {
        switch (variant) {
          case "primary":
          case "danger":
          case "warning":
          case "success":
            return "text-white";
          case "merged":
            return "text-merged-contrast";
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
        case "merged":
          return "text-purple-6";
        case "secondary":
          return "text-text-1";
        case "tertiary":
          return "text-text-2 group-hover/button-split:text-text-1";
      }
    })();

    const menuStateClass = (() => {
      if (isDisabled) return "";
      if (resolvedAppearance === "solid") {
        switch (variant) {
          case "primary":
            return menuOpen
              ? "bg-primary-5 enabled:hover:bg-primary-5"
              : "enabled:hover:bg-primary-5";
          case "danger":
            return menuOpen
              ? "bg-danger-5 enabled:hover:bg-danger-5"
              : "enabled:hover:bg-danger-5";
          case "warning":
            return menuOpen
              ? "bg-warning-5 enabled:hover:bg-warning-5"
              : "enabled:hover:bg-warning-5";
          case "success":
            return menuOpen
              ? "bg-success-5 enabled:hover:bg-success-5"
              : "enabled:hover:bg-success-5";
          case "merged":
            return menuOpen
              ? "bg-merged-hover enabled:hover:bg-merged-hover"
              : "enabled:hover:bg-merged-hover";
          case "secondary":
          case "tertiary":
            break;
        }
      }
      return "enabled:hover:bg-fill-3";
    })();

    const resolvedMenuWidth =
      menuSegmentWidth ??
      (iconOnly ? sizeConfig.height / 2 : sizeConfig.height);
    const resolvedMainWidth = iconOnly
      ? (mainSegmentWidth ?? sizeConfig.height)
      : undefined;
    const splitButtonWidth = iconOnly
      ? (resolvedMainWidth ?? sizeConfig.height) + resolvedMenuWidth
      : undefined;
    const shouldHug = widthMode === "hug" && !iconOnly && !long;

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
            flex: shouldHug ? "none" : 1,
            display: "flex",
            minWidth: 0,
          }}
        >
          <button
            ref={ref}
            type={htmlType}
            disabled={isDisabled}
            className={`${buttonClassName} ${wrapperHoverClass}`.trim()}
            style={{
              ...buttonStyles,
              width: shouldHug ? "auto" : (splitButtonWidth ?? "100%"),
              minWidth: 0,
              flex: iconOnly || shouldHug ? "none" : 1,
              paddingRight: iconOnly ? 0 : `${resolvedMenuWidth}px`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              position: "relative",
            }}
            onClick={onClick}
            {...rest}
          >
            {shouldHug ? (
              buttonContent
            ) : (
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  right: contentAlignment === "whole" ? 0 : resolvedMenuWidth,
                  top: 0,
                  bottom: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
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
            aria-label={menuButtonLabel}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={`transition-colors ${menuStateClass} ${menuColorClass}`}
            style={{
              position: "absolute",
              right: 0,
              top: 0,
              bottom: 0,
              width: resolvedMenuWidth,
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
            onClick={onMenuButtonClick}
          >
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              data-icon="chevron-down"
              size={12}
              aria-hidden
            />
          </button>
        </div>

        {menuOpen && menu}
      </div>
    );
  }
);

SplitButton.displayName = "SplitButton";

export default SplitButton;
