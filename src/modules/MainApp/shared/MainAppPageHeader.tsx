import React from "react";

import {
  COLLAPSED_SIDEBAR_CHROME_OFFSET,
  useShouldOffsetMainAppHeader,
} from "@src/hooks/ui/sidebar/useCollapsedSidebarChromeOffset";
import { PageBreadcrumb } from "@src/modules/shared/layouts/blocks";
import { CollapsedSidebarButton } from "@src/scaffold/NavigationSidebar/CollapsedSidebarButton";

interface MainAppPageHeaderProps {
  breadcrumb?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  offsetForCollapsedSidebar?: boolean;
}

const DRAG_STYLE = { WebkitAppRegion: "drag" } as React.CSSProperties;
const NO_DRAG_STYLE = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

const MainAppPageHeader: React.FC<MainAppPageHeaderProps> = ({
  breadcrumb,
  actions,
  className = "",
  style,
  offsetForCollapsedSidebar,
}) => {
  const defaultOffsetForCollapsedSidebar = useShouldOffsetMainAppHeader();
  const shouldOffsetHeaderForCollapsedSidebar =
    offsetForCollapsedSidebar ?? defaultOffsetForCollapsedSidebar;

  return (
    <div
      className={`workspace-header header-tab-group relative z-30 flex h-11 min-h-11 flex-shrink-0 items-center gap-1.5 px-2 pt-2 ${className}`}
      data-tauri-drag-region
      style={
        {
          ...style,
          paddingLeft: shouldOffsetHeaderForCollapsedSidebar
            ? COLLAPSED_SIDEBAR_CHROME_OFFSET
            : undefined,
          ...DRAG_STYLE,
        } as React.CSSProperties
      }
    >
      {shouldOffsetHeaderForCollapsedSidebar ? (
        <div style={NO_DRAG_STYLE}>
          <CollapsedSidebarButton />
        </div>
      ) : null}
      <div
        className="flex h-9 min-w-0 shrink items-center gap-1"
        style={NO_DRAG_STYLE}
      >
        {breadcrumb ?? <PageBreadcrumb />}
      </div>
      <div
        className="min-w-0 flex-1"
        aria-hidden
        data-tauri-drag-region
        style={DRAG_STYLE}
      />
      {actions && (
        <div
          className="flex flex-shrink-0 items-center gap-px self-stretch"
          style={NO_DRAG_STYLE}
        >
          {actions}
        </div>
      )}
    </div>
  );
};

export default MainAppPageHeader;
