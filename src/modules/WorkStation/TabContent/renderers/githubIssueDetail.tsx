/**
 * Renderer for `github-issue-detail` tabs.
 *
 * Reads the selected issue from `workstationSelectedIssueAtom` and action
 * callbacks from `workstationIssueCallbackAtom`, then delegates to the
 * existing `IssueDetailPanel` component.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { memo, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { usePublishWorkstationTabHeader } from "@src/hooks/workStation";
import { useWorkStationTabs } from "@src/hooks/workStation/tabs/useWorkStationTabs";
import {
  IssueDetailExternalLinkButton,
  IssueDetailHeaderContent,
  IssueDetailPanel,
} from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueDetailPanel";
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

const GitHubIssueDetailTabRenderer: React.FC<UnifiedTabContentProps> = memo(
  ({ tab }) => {
    const { t } = useTranslation();
    const selectedState = useAtomValue(workstationSelectedIssueAtom);
    const callbacks = useAtomValue(workstationIssueCallbackAtom);
    const setSelectedState = useSetAtom(workstationSelectedIssueAtom);
    const { closeTab } = useWorkStationTabs();
    const tabData = tab.data as unknown as GitHubIssueDetailTabData;

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

    const headerContent = useMemo(
      () => (
        <IssueDetailHeaderContent
          issue={selectedState.issue}
          fallbackTitle={tab.title}
        />
      ),
      [selectedState.issue, tab.title]
    );

    const headerTrailing = useMemo(() => {
      const issue = selectedState.issue;
      if (!issue) return null;
      return <IssueDetailExternalLinkButton issue={issue} />;
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
