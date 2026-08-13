import type { ReactNode } from "react";

import { useStickyMount } from "@src/modules/shared/hooks/useStickyMount";

export interface PersistentDetailTabPanelProps {
  active: boolean;
  ariaLabelledBy: string;
  children: ReactNode;
  className?: string;
  id: string;
  testId?: string;
}

/**
 * Lazily mounts detail-tab content on first visit, then hides it instead of
 * unmounting it so local state and native scroll positions survive tab changes.
 */
export default function PersistentDetailTabPanel({
  active,
  ariaLabelledBy,
  children,
  className = "",
  id,
  testId,
}: PersistentDetailTabPanelProps) {
  const shouldRender = useStickyMount(active);
  if (!shouldRender) return null;

  return (
    <div
      role="tabpanel"
      id={id}
      aria-labelledby={ariaLabelledBy}
      aria-hidden={!active}
      className={`min-h-0 flex-1 ${className}`.trim()}
      data-testid={testId}
      style={{ display: active ? "flex" : "none" }}
    >
      {children}
    </div>
  );
}
