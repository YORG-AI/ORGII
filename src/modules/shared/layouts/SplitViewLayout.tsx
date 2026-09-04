/**
 * SplitViewLayout Component
 *
 * A reusable resizable, collapsible List (left) + Content (right) layout.
 */
import PageBreadcrumb from "@/src/modules/shared/layouts/blocks/PageBreadcrumb";
import { useAtomValue } from "jotai";
import React, { memo, useCallback, useEffect, useState } from "react";

import { ResizableSplitPanel } from "@src/scaffold/Resize";
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";

export interface SplitViewLayoutProps {
  /** List panel content */
  listContent: React.ReactNode;
  /** Surface-owned rows pinned above the scrolling list content. */
  listHeader?: React.ReactNode;
  /** Main content area */
  mainContent: React.ReactNode;
  /** List panel width in pixels */
  listWidth?: number;
  /** Minimum list panel width */
  minListWidth?: number;
  /** Maximum list panel width */
  maxListWidth?: number;
  /** Custom className */
  className?: string;
  /** Custom className for main content area */
  mainContentClassName?: string;
  /** Background class for the list (left) panel — default matches app split views */
  listPanelBackgroundClassName?: string;
  /** Hide breadcrumb header when sidebar is collapsed */
  hideBreadcrumbWhenSidebarCollapsed?: boolean;
  /** Whether the resizable split draws a resting divider line. */
  showDivider?: boolean;
}

/** Shared style for CSS containment */
const containStyle = { contain: "layout style" } as const;

const SplitViewLayout: React.FC<SplitViewLayoutProps> = ({
  listContent,
  listHeader,
  mainContent,
  listWidth = 200,
  minListWidth = 160,
  maxListWidth = 320,
  className = "",
  mainContentClassName = "bg-bg-2",
  listPanelBackgroundClassName = "bg-bg-2",
  hideBreadcrumbWhenSidebarCollapsed = false,
  showDivider = true,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const isSidebarCollapsed = useAtomValue(sidebarCollapsedAtom);

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  // Listen for Cmd+B / Ctrl+B keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Cmd+B on Mac, Ctrl+B on Windows/Linux
      if ((event.metaKey || event.ctrlKey) && event.key === "b") {
        event.preventDefault();
        toggleCollapse();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleCollapse]);

  const listPanel = (
    <div
      className={`flex h-full min-w-0 flex-col ${listPanelBackgroundClassName}`}
      style={containStyle}
    >
      {isSidebarCollapsed && !hideBreadcrumbWhenSidebarCollapsed && (
        <div className="flex h-[40px] shrink-0 items-center px-3">
          <PageBreadcrumb />
        </div>
      )}
      {listHeader}
      <div className="scrollbar-overlay min-h-0 flex-1 overflow-y-auto">
        {listContent}
      </div>
    </div>
  );

  return (
    <div
      className={`flex h-full min-h-0 w-full min-w-0 flex-col ${className}`}
      style={containStyle}
    >
      {!isCollapsed ? (
        <ResizableSplitPanel
          defaultLeftWidth={listWidth}
          minLeftWidth={minListWidth}
          maxLeftWidth={maxListWidth}
          leftPanel={listPanel}
          rightPanel={
            <div
              className={`h-full min-w-0 overflow-hidden ${mainContentClassName}`}
              style={containStyle}
            >
              {mainContent}
            </div>
          }
          className="flex-1"
          showDivider={showDivider}
        />
      ) : (
        <div className="flex flex-1 overflow-hidden">
          <div
            className={`flex min-w-0 flex-1 flex-col overflow-hidden ${mainContentClassName}`}
            style={{ contain: "inline-size layout style" }}
          >
            {mainContent}
          </div>
        </div>
      )}
    </div>
  );
};

// Memoize to prevent unnecessary re-renders during page transitions
export default memo(SplitViewLayout);
