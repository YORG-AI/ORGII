import React from "react";

import SplitViewLayout from "./SplitViewLayout";

export const INBOX_LIST_DETAIL_WIDTH = {
  default: 360,
  min: 280,
  max: 480,
} as const;

export interface InboxListDetailLayoutProps {
  /** Compact Inbox-format navigation shown while the detail is open. */
  listContent: React.ReactNode;
  /** Surface-owned rows pinned above the scrolling left list. */
  listHeader?: React.ReactNode;
  /** Surface-owned row pinned above the full-width presentation. */
  fullHeader?: React.ReactNode;
  detailContent: React.ReactNode;
  /** Existing full-width table, board, calendar, or list presentation. */
  fullContent?: React.ReactNode;
  /** With fullContent, controls whether the surface is single or split pane. */
  detailOpen?: boolean;
  /**
   * Keep the compact list and its right-hand detail holder visible before an
   * item is selected. Use this for detail-first work surfaces; board and
   * table-focused surfaces can retain their full-width default.
   */
  defaultSplit?: boolean;
  /** Restores the existing one-pane presentation instead of the split view. */
  listFullscreen?: boolean;
  testId?: string;
  className?: string;
}

/**
 * Shared one-pane/two-pane contract used by Inbox and work-management pages.
 * A full view remains mounted only in one-pane mode; selection swaps it for
 * the compact Inbox list and the selected detail.
 */
const InboxListDetailLayout: React.FC<InboxListDetailLayoutProps> = ({
  listContent,
  listHeader,
  fullHeader,
  detailContent,
  fullContent,
  detailOpen = true,
  defaultSplit = false,
  listFullscreen = false,
  testId = "inbox-list-detail-layout",
  className = "",
}) => {
  const hasFullContent = fullContent !== undefined;
  // Expand returns the surface to its established one-pane presentation
  // (table or full list), rather than merely hiding the right split pane.
  const showSplit = !listFullscreen && (detailOpen || defaultSplit);
  if (hasFullContent && !showSplit) {
    return (
      <div
        className={`flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden ${className}`.trim()}
        data-testid={testId}
        data-layout-mode="single"
      >
        {fullHeader}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {fullContent}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`h-full min-h-0 w-full min-w-0 overflow-hidden ${className}`.trim()}
      data-testid={testId}
      data-layout-mode="split"
    >
      <SplitViewLayout
        className="min-h-0 flex-1 rounded-page"
        listWidth={INBOX_LIST_DETAIL_WIDTH.default}
        minListWidth={INBOX_LIST_DETAIL_WIDTH.min}
        maxListWidth={INBOX_LIST_DETAIL_WIDTH.max}
        hideBreadcrumbWhenSidebarCollapsed
        listPanelBackgroundClassName="bg-chat-pane"
        mainContentClassName="bg-chat-pane"
        showDivider={false}
        listHeader={listHeader}
        listContent={listContent}
        mainContent={detailContent}
      />
    </div>
  );
};

export default InboxListDetailLayout;
