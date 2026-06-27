/**
 * Renderer for `github-issue-detail` tabs.
 *
 * Reads the selected issue from `workstationSelectedIssueAtom` and action
 * callbacks from `workstationIssueCallbackAtom`, then delegates to the
 * existing `IssueDetailPanel` component.
 */
import { useAtomValue, useSetAtom } from "jotai";
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
  addIssueComment,
  closeIssue,
  reopenIssue,
} from "@src/services/git/operations/githubIssues";
import {
  workstationIssueCallbackAtom,
  workstationSelectedIssueAtom,
} from "@src/store/workstation/codeEditor/workstationIssueAtom";
import type { GitHubIssueDetailTabData } from "@src/store/workstation/tabs";

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
    const setSelectedState = useSetAtom(workstationSelectedIssueAtom);
    const { closeTab } = useWorkStationTabs();
    const tabData = tab.data as GitHubIssueDetailTabData;

    const handleClose = useCallback(() => {
      closeTab(tab.id);
    }, [closeTab, tab.id]);

    const handleCloseIssue = useCallback(() => {
      const issue = selectedState.issue;
      if (!issue) return;
      if (callbacks.closeIssue) {
        void callbacks.closeIssue(issue.number);
        return;
      }
      const remoteUrl = tabData.remoteUrl;
      if (!remoteUrl) return;
      void (async () => {
        const result = await closeIssue({
          remoteUrl,
          issueNumber: issue.number,
        });
        if (result.data) {
          setSelectedState((prev) =>
            prev.issue?.number === issue.number
              ? { ...prev, issue: result.data }
              : prev
          );
        } else {
          setSelectedState((prev) => ({ ...prev, error: result.error }));
        }
      })();
    }, [selectedState.issue, callbacks, tabData.remoteUrl, setSelectedState]);

    const handleReopenIssue = useCallback(() => {
      const issue = selectedState.issue;
      if (!issue) return;
      if (callbacks.reopenIssue) {
        void callbacks.reopenIssue(issue.number);
        return;
      }
      const remoteUrl = tabData.remoteUrl;
      if (!remoteUrl) return;
      void (async () => {
        const result = await reopenIssue({
          remoteUrl,
          issueNumber: issue.number,
        });
        if (result.data) {
          setSelectedState((prev) =>
            prev.issue?.number === issue.number
              ? { ...prev, issue: result.data }
              : prev
          );
        } else {
          setSelectedState((prev) => ({ ...prev, error: result.error }));
        }
      })();
    }, [selectedState.issue, callbacks, tabData.remoteUrl, setSelectedState]);

    const handleAddComment = useCallback(
      async (body: string) => {
        const issue = selectedState.issue;
        if (!issue) return;
        if (callbacks.addComment) {
          await callbacks.addComment(issue.number, body);
          return;
        }
        if (!tabData.remoteUrl) {
          throw new Error("missing_remote_url");
        }
        setSelectedState((prev) => ({ ...prev, submittingComment: true }));
        const result = await addIssueComment({
          remoteUrl: tabData.remoteUrl,
          issueNumber: issue.number,
          body,
        });
        if (result.data) {
          const comment = result.data;
          setSelectedState((prev) => ({
            ...prev,
            issue:
              prev.issue?.number === issue.number
                ? { ...prev.issue, comments: prev.issue.comments + 1 }
                : prev.issue,
            comments: [...prev.comments, comment],
            submittingComment: false,
          }));
        } else {
          setSelectedState((prev) => ({
            ...prev,
            error: result.error,
            submittingComment: false,
          }));
          throw new Error(result.error);
        }
      },
      [selectedState.issue, callbacks, tabData.remoteUrl, setSelectedState]
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
