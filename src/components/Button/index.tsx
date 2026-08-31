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
 *                 "merged"    = completed GitHub merge
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
import React, { forwardRef } from "react";

import {
  type ButtonAppearance,
  type ButtonShape,
  type ButtonSize,
  type ButtonVariant,
  useButtonPresentation,
} from "./presentation";

export type { ButtonAppearance, ButtonVariant } from "./presentation";

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
  size?: ButtonSize;

  /**
   * Button shape
   * @default "square"
   */
  shape?: ButtonShape;

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

  /**
   * Center the label on the button's own center, taking the icon out of flow so
   * it sits beside the centered label instead of shifting it. Intended for
   * full-width buttons — on a hug-width button the icon overhangs the edge.
   * @default false
   */
  centerLabel?: boolean;

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
      centerLabel = false,
      long = false,
      htmlType = "button",
      href,
      target,
      rel,
      children,
      className = "",
      style,
      onClick,
      ...rest
    },
    ref
  ) => {
    const { isDisabled, buttonStyles, buttonContent, buttonClassName } =
      useButtonPresentation({
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
