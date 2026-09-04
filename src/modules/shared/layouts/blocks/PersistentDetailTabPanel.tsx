import { type ReactNode, useMemo } from "react";

import { useKeepAliveWindow } from "@src/hooks/ui/useKeepAliveWindow";

/**
 * How long a detail tab stays mounted-but-hidden after the user switches
 * away. A PR's Changes tab can hold dozens of CodeMirror diff views; keeping
 * it warm for a minute makes "glance at Checks, come back" instant while a
 * tab abandoned for the rest of the visit stops holding its subtree.
 */
export const DETAIL_TAB_PANEL_GRACE_MS = 60_000;

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
 * unmounting it for `DETAIL_TAB_PANEL_GRACE_MS`, so local state and native
 * scroll positions survive quick tab changes. A panel hidden for longer than
 * the grace window unmounts and is rebuilt on its next visit.
 */
export default function PersistentDetailTabPanel({
  active,
  ariaLabelledBy,
  children,
  className = "",
  id,
  testId,
}: PersistentDetailTabPanelProps) {
  const panelKeys = useMemo(() => [id], [id]);
  const warmPanels = useKeepAliveWindow(active ? id : null, panelKeys, {
    graceMs: DETAIL_TAB_PANEL_GRACE_MS,
  });
  if (!warmPanels.has(id)) return null;

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
