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
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border-2 px-3">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {onBack ? (
          <IconButton
            type="button"
            size="sm"
            variant="default"
            aria-label={backAriaLabel}
            onClick={onBack}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} size={18} />
          </IconButton>
        ) : (
          leading
        )}
        {title ? (
          <div className="min-w-0 truncate text-sm font-medium text-text-1">
            {title}
          </div>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </header>
  );
}

MobileTopBar.displayName = "MobileTopBar";
