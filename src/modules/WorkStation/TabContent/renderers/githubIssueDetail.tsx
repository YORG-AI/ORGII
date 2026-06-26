/**
 * Renderer for `github-issue-detail` tabs.
 *
 * Reads the selected issue from `workstationSelectedIssueAtom` and action
 * callbacks from `workstationIssueCallbackAtom`, then delegates to the
 * existing `IssueDetailPanel` component.
 */
import { useAtomValue } from "jotai";
import { CheckCircle2, CircleDot, ExternalLink } from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { HEADER_ICON_SIZE } from "@src/config/workstation/tokens";
import { usePublishWorkstationTabHeader } from "@src/hooks/workStation";
import { useWorkStationTabs } from "@src/hooks/workStation/tabs/useWorkStationTabs";
import { IssueDetailPanel } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  workstationIssueCallbackAtom,
  workstationSelectedIssueAtom,
} from "@src/store/workstation/codeEditor/workstationIssueAtom";

import type { UnifiedTabContentProps } from "../types";

function HeaderIssueStateIcon({
  isOpen,
}: {
  isOpen: boolean;
}): React.ReactNode {
  if (isOpen) return <CircleDot size={14} strokeWidth={1.8} />;
  return <CheckCircle2 size={14} strokeWidth={1.8} />;
}

const GitHubIssueDetailTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const { t } = useTranslation();
    const selectedState = useAtomValue(workstationSelectedIssueAtom);
    const callbacks = useAtomValue(workstationIssueCallbackAtom);
    const { closeTab } = useWorkStationTabs();

    const handleClose = useCallback(() => {
      closeTab(tab.id);
    }, [closeTab, tab.id]);

    const handleCloseIssue = useCallback(() => {
      if (selectedState.issue && callbacks.closeIssue) {
        void callbacks.closeIssue(selectedState.issue.number);
      }
    }, [selectedState.issue, callbacks]);

    const handleReopenIssue = useCallback(() => {
      if (selectedState.issue && callbacks.reopenIssue) {
        void callbacks.reopenIssue(selectedState.issue.number);
      }
    }, [selectedState.issue, callbacks]);

    const handleAddComment = useCallback(
      async (body: string) => {
        if (selectedState.issue && callbacks.addComment) {
          await callbacks.addComment(selectedState.issue.number, body);
        }
      },
      [selectedState.issue, callbacks]
    );

    const headerContent = useMemo(() => {
      const issue = selectedState.issue;
      if (!issue) {
        return (
          <span className="min-w-0 truncate text-[13px] font-medium text-text-1">
            {tab.title}
          </span>
        );
      }

      const stateClassName =
        issue.state === "open" ? "text-success-6" : "text-purple-6";
      return (
        <span className="flex min-w-0 items-center gap-2">
          <span className={`shrink-0 ${stateClassName}`}>
            <HeaderIssueStateIcon isOpen={issue.state === "open"} />
          </span>
          <span className="shrink-0 text-[11px] text-text-3">
            #{issue.number}
          </span>
          <span
            className="min-w-0 truncate text-[13px] font-medium text-text-1"
            title={issue.title}
          >
            {issue.title}
          </span>
        </span>
      );
    }, [selectedState.issue, tab.title]);

    const headerTrailing = useMemo(() => {
      const issue = selectedState.issue;
      if (!issue) return null;
      return (
        <Button
          href={issue.html_url}
          target="_blank"
          rel="noopener noreferrer"
          variant="tertiary"
          size="small"
          iconOnly
          icon={<ExternalLink size={HEADER_ICON_SIZE.sm} strokeWidth={2} />}
          title="Open on GitHub"
        />
      );
    }, [selectedState.issue]);

    usePublishWorkstationTabHeader({
      host: "code",
      content: {
        content: headerContent,
        trailing: headerTrailing,
        sidebarToggleDisabled: true,
      },
    });

    if (!selectedState.issue) {
      return (
        <Placeholder
          variant="empty"
          placement="detail-panel"
          title={t("previews.noIssueSelected")}
          subtitle={t("previews.selectIssueHint")}
        />
      );
    }

    return (
      <IssueDetailPanel
        issue={selectedState.issue}
        comments={selectedState.comments}
        commentsLoading={selectedState.commentsLoading}
        submittingComment={selectedState.submittingComment}
        showHeader={false}
        onClose={handleClose}
        onCloseIssue={handleCloseIssue}
        onReopenIssue={handleReopenIssue}
        onAddComment={handleAddComment}
      />
    );
  }
);

GitHubIssueDetailTabRenderer.displayName = "GitHubIssueDetailTabRenderer";

export default GitHubIssueDetailTabRenderer;
