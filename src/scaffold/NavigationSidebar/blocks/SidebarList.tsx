/**
 * SidebarList
 *
 * Scrollable list container for sidebar content.
 * Contains SidebarSections with consistent gap between them.
 */
import React, { useMemo } from "react";

import { Placeholder } from "@src/modules/shared/layouts/blocks";

import { SIDEBAR_PADDING } from "../config";
import type { SidebarListProps } from "../types";

// Static style — stable reference, never re-created
const SECTION_GAP_STYLE = { gap: `${SIDEBAR_PADDING.sectionGap}px` } as const;

// ============================================
// SidebarList Component
// ============================================

const SidebarList: React.FC<SidebarListProps> = React.memo(
  ({
    children,
    scrollContainerRef,
    isLoading = false,
    theme,
    className = "",
    topPadding = false,
  }) => {
    // Theme-aware loading style — memoized
    const loadingStyle = useMemo(
      () => (theme ? { color: `${theme.foreground}60` } : undefined),
      [theme]
    );

    if (isLoading) {
      return (
        <div
          className={`flex flex-1 flex-col items-center justify-center ${className}`}
          style={loadingStyle}
        >
          <Placeholder variant="loading" />
        </div>
      );
    }

    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div
          ref={scrollContainerRef}
          className={`sidebar-list min-h-0 flex-1 overflow-y-auto px-3 ${topPadding ? "pt-3" : ""} scrollbar-hide ${className}`}
        >
          <div className="flex flex-col" style={SECTION_GAP_STYLE}>
            {children}
          </div>
        </div>
      </div>
    );
  }
);

SidebarList.displayName = "SidebarList";

export default SidebarList;
