import React from "react";

export interface MobileShellProps {
  children: React.ReactNode;
  footer?: React.ReactNode;
}

/**
 * Narrow viewport shell for Mobile Remote PWA demo (393px baseline).
 */
export function MobileShell({ children, footer }: MobileShellProps) {
  return (
    <div className="flex h-full justify-center overflow-hidden bg-bg-1 pt-[env(safe-area-inset-top)]">
      <div className="flex h-full min-h-0 w-full max-w-[393px] flex-col overflow-hidden bg-bg-1">
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
        {footer}
      </div>
    </div>
  );
}

MobileShell.displayName = "MobileShell";
