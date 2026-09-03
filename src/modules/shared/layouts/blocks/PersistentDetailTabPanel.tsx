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
      // A tab panel is a vertical stack. The row default of `display: flex`
      // left content that carries no width of its own — anything rooted in
      // `DetailPanelContainer`, whose `@container` children are gated behind
      // `@[300px]`, or any `min-w-0` child without `flex-1` — collapsing to
      // zero width and rendering nothing at all. Callers may still pass
      // `flex-col` explicitly; the duplicate class is inert.
      className={[
        ...new Set([
          "flex",
          "min-h-0",
          "flex-1",
          "flex-col",
          ...className.split(/\s+/),
        ]),
      ]
        .filter(Boolean)
        .join(" ")}
      data-testid={testId}
      style={{ display: active ? "flex" : "none" }}
    >
      {children}
    </div>
  );
}
