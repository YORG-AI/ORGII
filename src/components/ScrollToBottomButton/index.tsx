import React from "react";

import Button from "@src/components/Button";
import { PILL_CONTROL_IDLE_SURFACE_CLASS } from "@src/components/CompoundPill/config";
import { ArrowDown02Icon, HugeiconsIcon } from "@src/icons";

export interface ScrollToBottomButtonProps {
  label: string;
  onClick: () => void;
  className?: string;
}

/** Shared ChatPanel/feed affordance for returning to the live tail. */
export const ScrollToBottomButton = React.memo(
  ({ label, onClick, className = "" }: ScrollToBottomButtonProps) => (
    <Button
      variant="secondary"
      appearance="outline"
      size="small"
      shape="round"
      icon={
        <HugeiconsIcon
          icon={ArrowDown02Icon}
          data-icon="arrow-down"
          size={14}
        />
      }
      iconOnly
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`shrink-0 ${PILL_CONTROL_IDLE_SURFACE_CLASS} ${className}`}
    />
  )
);

ScrollToBottomButton.displayName = "ScrollToBottomButton";

export default ScrollToBottomButton;
