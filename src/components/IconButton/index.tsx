/**
 * Shared icon-only button.
 *
 * Use for compact header, toolbar, and row action icons across ChatPanel,
 * WorkStation, and shared surfaces.
 */
import React, { forwardRef, memo } from "react";

import { BUTTON_SIZE, BUTTON_VARIANT } from "@src/config/workstation/tokens";

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  size?: keyof typeof BUTTON_SIZE;
  variant?: keyof typeof BUTTON_VARIANT;
  children: React.ReactNode;
}

const BASE_CLASSES =
  "flex items-center justify-center rounded transition-colors disabled:cursor-not-allowed disabled:opacity-50";

export const IconButton = memo(
  forwardRef<HTMLButtonElement, IconButtonProps>(
    (
      { size = "sm", variant = "default", className = "", children, ...props },
      ref
    ) => {
      const sizeClass = BUTTON_SIZE[size];
      const variantClass = BUTTON_VARIANT[variant];

      return (
        <button
          ref={ref}
          className={`${BASE_CLASSES} ${sizeClass} ${variantClass} ${className}`}
          {...props}
        >
          {children}
        </button>
      );
    }
  )
);

IconButton.displayName = "IconButton";

export default IconButton;
