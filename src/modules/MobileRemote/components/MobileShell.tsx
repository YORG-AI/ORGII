import React from "react";

import "../mobileChrome.scss";

export interface MobileShellProps {
  children: React.ReactNode;
  footer?: React.ReactNode;
}

/**
 * Safe-area-aware mobile shell shared by the browser and native entries.
 */
export function MobileShell({ children, footer }: MobileShellProps) {
  return (
    <div className="mobile-shell flex h-full justify-center overflow-hidden pt-[env(safe-area-inset-top)]">
      <div className="mobile-shell__viewport flex h-full min-h-0 w-full flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        {footer}
      </div>
    </div>
  );
}

MobileShell.displayName = "MobileShell";
