import React from "react";

import { LIST_PANEL_SCROLL_AREA } from "./tokens";

export interface ListPanelScrollAreaProps {
  children: React.ReactNode;
  listPaddingTop?: "default" | "none";
  className?: string;
}

const ListPanelScrollArea: React.FC<ListPanelScrollAreaProps> = ({
  children,
  listPaddingTop = "default",
  className = "",
}) => (
  <div
    className={`min-h-0 flex-1 overflow-y-auto px-2 scrollbar-hide ${listPaddingTop === "none" ? LIST_PANEL_SCROLL_AREA.paddingTopNone : LIST_PANEL_SCROLL_AREA.paddingTopDefault} ${className}`.trim()}
  >
    {children}
  </div>
);

export default ListPanelScrollArea;
