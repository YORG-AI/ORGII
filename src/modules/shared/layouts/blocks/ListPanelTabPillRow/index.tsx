/**
 * ListPanelTabPillRow
 *
 * Container for TabPill in SplitViewLayout left panels.
 * Replaces PanelHeader when the header is only tab pills.
 */
import React from "react";

interface ListPanelTabPillRowProps {
  children: React.ReactNode;
  className?: string;
}

const ListPanelTabPillRow: React.FC<ListPanelTabPillRowProps> = ({
  children,
  className = "",
}) => (
  <div
    className={`flex h-10 flex-shrink-0 items-center gap-2 bg-bg-2 px-3 ${className}`.trim()}
  >
    {children}
  </div>
);

export default ListPanelTabPillRow;
