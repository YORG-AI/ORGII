import React from "react";

import Button, { type ButtonProps } from "@src/components/Button";

/** Large mobile actions retain the shared button's loading and disabled behavior. */
export function MobileActionButton({
  variant = "primary",
  className = "",
  style,
  ...props
}: ButtonProps) {
  return (
    <Button
      {...props}
      variant={variant}
      size="large"
      shape="round"
      className={`mobile-action-button ${className}`}
      data-mobile-variant={variant}
      style={{
        height: "auto",
        minHeight: "var(--mobile-action-height)",
        padding: "var(--mobile-action-padding)",
        fontSize: "var(--mobile-action-font-size)",
        ...style,
      }}
    />
  );
}

MobileActionButton.displayName = "MobileActionButton";
