/**
 * ListPanelScrollArea — Reusable scroll container for left list panels.
 *
 * Wraps list content with standard scroll behavior and configurable top padding.
 * Place below ListPanelTabPillRow or ListPanelSearch.
 *
 * Used by: MenuPanel, InboxListPanel, and similar panels.
 */
import React from "react";

import { LIST_PANEL_SCROLL_AREA } from "@src/components/ListPanel/tokens";

export interface ListPanelScrollAreaProps {
  children: React.ReactNode;
  /** Top padding between header/search and list. Default: "default" (pt-2). Use "none" to remove gap. */
  listPaddingTop?: "default" | "none";
  className?: string;
}

const ListPanelScrollArea: React.FC<ListPanelScrollAreaProps> = ({
  children,
  listPaddingTop = "default",
  className = "",
}) => (
  <div
    className={`scrollbar-hide min-h-0 flex-1 overflow-y-auto px-2 ${listPaddingTop === "none" ? LIST_PANEL_SCROLL_AREA.paddingTopNone : LIST_PANEL_SCROLL_AREA.paddingTopDefault} ${className}`.trim()}
  >
    {children}
  </div>
);

export default ListPanelScrollArea;
