import React from "react";

import { IconButton } from "@src/components/IconButton";
import { ArrowLeft01Icon, HugeiconsIcon } from "@src/icons";

export interface MobileTopBarProps {
  title?: React.ReactNode;
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  onBack?: () => void;
  backAriaLabel?: string;
}

export function MobileTopBar({
  title,
  leading,
  trailing,
  onBack,
  backAriaLabel = "Back",
}: MobileTopBarProps) {
  return (
    <header
      className={`mobile-top-bar ${onBack ? "mobile-top-bar--detail" : "mobile-top-bar--root"}`}
    >
      {onBack ? (
        <IconButton
          type="button"
          size="sm"
          variant="default"
          className="mobile-chrome-icon-button"
          aria-label={backAriaLabel}
          onClick={onBack}
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} size={22} />
        </IconButton>
      ) : leading ? (
        <div className="mobile-top-bar__leading">{leading}</div>
      ) : null}
      {title ? <h1 className="mobile-top-bar__title">{title}</h1> : null}
      {trailing ? (
        <div className="mobile-top-bar__trailing">{trailing}</div>
      ) : null}
    </header>
  );
}

MobileTopBar.displayName = "MobileTopBar";
