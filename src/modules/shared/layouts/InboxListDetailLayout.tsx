import React from "react";

import CompactListHeader from "./CompactListHeader";
import SplitViewLayout from "./SplitViewLayout";

export const INBOX_LIST_DETAIL_WIDTH = {
  default: 360,
  min: 280,
  max: 480,
} as const;

export interface InboxListDetailLayoutProps {
  /** Compact Inbox-format navigation shown while the detail is open. */
  listContent: React.ReactNode;
  /** Dataset controls moved above the compact list only in split mode. */
  listHeader?: React.ReactNode;
  detailContent: React.ReactNode;
  /** Existing full-width table, board, calendar, or list presentation. */
  fullContent?: React.ReactNode;
  /** With fullContent, controls whether the surface is single or split pane. */
  detailOpen?: boolean;
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
  detailContent,
  fullContent,
  detailOpen = true,
  testId = "inbox-list-detail-layout",
  className = "",
}) => {
  const hasFullContent = fullContent !== undefined;
  if (hasFullContent && !detailOpen) {
    return (
      <div
        className={`h-full min-h-0 w-full min-w-0 overflow-hidden ${className}`.trim()}
        data-testid={testId}
        data-layout-mode="single"
      >
        {fullContent}
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
        resizable
        collapsible
        hideBreadcrumbWhenSidebarCollapsed
        listPanelBackgroundClassName="bg-chat-pane"
        mainContentClassName="bg-chat-pane"
        listContent={
          <div className="flex h-full min-h-0 flex-col">
            {listHeader ? (
              <CompactListHeader>{listHeader}</CompactListHeader>
            ) : null}
            <div className="min-h-0 flex-1 overflow-hidden">{listContent}</div>
          </div>
        }
        mainContent={detailContent}
      />
    </div>
  );
};

export default InboxListDetailLayout;
