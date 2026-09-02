/**
 * SplitViewLayout Component
 *
 * A reusable layout with NavigationBar + List (left) + Content (right)
 * Perfect for Git Diff, Code Search, and similar features
 *
 * ## Subpage mode
 *
 * Pass `subpage` to replace the split layout with a full-width takeover:
 * PanelHeader (back + breadcrumb) on top, subpage content below.
 * The list panel is hidden. Clicking Back calls `subpage.onBack`.
 */
import PageBreadcrumb from "@/src/modules/shared/layouts/blocks/PageBreadcrumb";
import { useAtomValue } from "jotai";
import React, { memo, useCallback, useEffect, useState } from "react";

import { ResizableSplitPanel } from "@src/scaffold/Resize";
import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";

import { PanelHeader, type PanelHeaderBreadcrumb } from "./blocks";

export interface SplitViewSubpage {
  /** Breadcrumb shown in the PanelHeader */
  breadcrumb: PanelHeaderBreadcrumb;
  /** Called when the user clicks the back arrow */
  onBack: () => void;
  /** Subpage content rendered full-width below the header */
  content: React.ReactNode;
}

export interface SplitViewLayoutProps {
  /** Navigation bar content (left side) */
  navLeftContent?: React.ReactNode;
  /** Navigation bar content (center) */
  navWorkspaceMainPanel?: React.ReactNode;
  /** Navigation bar content (right side) */
  navRightContent?: React.ReactNode;
  /** List panel content */
  listContent: React.ReactNode;
  /** Main content area */
  mainContent: React.ReactNode;
  /** List panel width in pixels */
  listWidth?: number;
  /** Minimum list panel width */
  minListWidth?: number;
  /** Maximum list panel width */
  maxListWidth?: number;
  /** Enable resizable list panel */
  resizable?: boolean;
  /** Enable collapsible list panel (Cmd+B / Ctrl+B) */
  collapsible?: boolean;
  /** Initial collapsed state */
  defaultCollapsed?: boolean;
  /** Custom className */
  className?: string;
  /** Custom className for main content area */
  mainContentClassName?: string;
  /** Background class for the list (left) panel — default matches app split views */
  listPanelBackgroundClassName?: string;
  /** Hide breadcrumb header when sidebar is collapsed */
  hideBreadcrumbWhenSidebarCollapsed?: boolean;
  /** Always render the list-panel breadcrumb row, regardless of sidebar state */
  alwaysShowBreadcrumb?: boolean;
  /** Trailing content rendered on the right of the list-panel breadcrumb row */
  listHeaderTrailing?: React.ReactNode;
  /** When set, hides the split and shows a full-width subpage with back header */
  subpage?: SplitViewSubpage | null;
}

/** Shared style for CSS containment */
const containStyle = { contain: "layout style" } as const;

const SplitViewLayout: React.FC<SplitViewLayoutProps> = ({
  navLeftContent,
  navWorkspaceMainPanel,
  navRightContent,
  listContent,
  mainContent,
  listWidth = 200,
  minListWidth = 160,
  maxListWidth = 320,
  resizable = true,
  collapsible = false,
  defaultCollapsed = false,
  className = "",
  mainContentClassName = "bg-bg-2",
  listPanelBackgroundClassName = "bg-bg-2",
  hideBreadcrumbWhenSidebarCollapsed = false,
  alwaysShowBreadcrumb = false,
  listHeaderTrailing,
  subpage,
}) => {
  const [isCollapsed, setIsCollapsed] = useState(defaultCollapsed);
  const isSidebarCollapsed = useAtomValue(sidebarCollapsedAtom);

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  // Listen for Cmd+B / Ctrl+B keyboard shortcut
  useEffect(() => {
    if (!collapsible) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      // Cmd+B on Mac, Ctrl+B on Windows/Linux
      if ((event.metaKey || event.ctrlKey) && event.key === "b") {
        event.preventDefault();
        toggleCollapse();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [collapsible, toggleCollapse]);

  if (subpage) {
    return (
      <div
        className={`flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden ${className}`}
        style={containStyle}
      >
        <PanelHeader
          onBack={subpage.onBack}
          breadcrumb={subpage.breadcrumb}
          borderBottom
        />
        <div className="min-h-0 flex-1 overflow-hidden">{subpage.content}</div>
      </div>
    );
  }

  return (
    <div
      className={`flex h-full min-h-0 w-full min-w-0 flex-col ${className}`}
      style={containStyle}
    >
      {/* Navigation Bar */}
      {(navLeftContent || navWorkspaceMainPanel || navRightContent) && (
        <div className="flex h-[40px] items-center border-b border-border-2 px-3">
          {navLeftContent}
          <div className="flex flex-1 justify-center">
            {navWorkspaceMainPanel}
          </div>
          {navRightContent}
        </div>
      )}

      {/* Main Content Area with Resizable Split */}
      {resizable && !isCollapsed ? (
        <ResizableSplitPanel
          defaultLeftWidth={listWidth}
          minLeftWidth={minListWidth}
          maxLeftWidth={maxListWidth}
          leftPanel={
            <div
              className={`flex h-full min-w-0 flex-col ${listPanelBackgroundClassName}`}
              style={containStyle}
            >
              {(alwaysShowBreadcrumb ||
                (isSidebarCollapsed &&
                  !hideBreadcrumbWhenSidebarCollapsed)) && (
                <div className="flex h-[40px] shrink-0 items-center justify-between gap-2 px-3">
                  <PageBreadcrumb />
                  {listHeaderTrailing && (
                    <div className="flex shrink-0 items-center gap-1.5">
                      {listHeaderTrailing}
                    </div>
                  )}
                </div>
              )}
              <div className="scrollbar-overlay min-h-0 flex-1 overflow-y-auto">
                {listContent}
              </div>
            </div>
          }
          rightPanel={
            <div
              className={`h-full min-w-0 overflow-hidden ${mainContentClassName}`}
              style={containStyle}
            >
              {mainContent}
            </div>
          }
          className="flex-1"
        />
      ) : isCollapsed ? (
        // Collapsed state - only show main content
        <div className="flex flex-1 overflow-hidden">
          <div
            className={`flex min-w-0 flex-1 flex-col overflow-hidden ${mainContentClassName}`}
            style={{ contain: "inline-size layout style" }}
          >
            {mainContent}
          </div>
        </div>
      ) : (
        // Non-resizable, non-collapsed state
        <div className="flex flex-1 overflow-hidden">
          <div
            className={`scrollbar-overlay min-w-0 shrink-0 overflow-y-auto border-r border-solid border-border-2 ${listPanelBackgroundClassName}`}
            style={{ width: `${listWidth}px`, ...containStyle }}
          >
            {listContent}
          </div>
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
