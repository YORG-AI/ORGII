import { CheckCircle2, CircleDot, MessageSquare, XCircle } from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";

import type { GitHubIssue } from "@src/api/tauri/github";
import IssueHoverCard from "@src/components/IssueHoverCard";
import { TreeRowBase, type TreeRowNode } from "@src/components/TreeRow";
import { TYPOGRAPHY } from "@src/config/workstation/tokens";
import type { TabDragPillPayload } from "@src/modules/WorkStation/shared/TabBar/tabDragTypes";
import { ReferenceDragGhost } from "@src/shared/dnd/ReferenceDragGhost";
import { setIssueDragStash } from "@src/shared/dnd/dragSideChannel";
import { useReferencePillDrag } from "@src/shared/dnd/useReferencePillDrag";

interface IssueRowProps {
  issue: GitHubIssue;
  depth?: number;
  isSelected: boolean;
  onClick: () => void;
}

export const IssueRow: React.FC<IssueRowProps> = memo(
  ({ issue, depth = 0, isSelected, onClick }) => {
    const isOpen = issue.state === "open";
    const isCompleted =
      issue.state === "closed" && issue.state_reason !== "not_planned";

    const buildIssuePayload = useCallback(
      () => ({
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueUrl: issue.html_url,
        issueState: issue.state,
        labels: issue.labels.map((label) => label.name),
        assignees: issue.assignees.map((assignee) => assignee.login),
        comments: issue.comments,
      }),
      [issue]
    );

    const buildIssuePillPayload = useCallback((): TabDragPillPayload => {
      const issuePayload = buildIssuePayload();
      return {
        path: `issue://${issuePayload.issueNumber}`,
        name: `#${issuePayload.issueNumber} ${issuePayload.issueTitle}`,
        iconType: "issue",
        isFolder: false,
        contextText: JSON.stringify(issuePayload),
      };
    }, [buildIssuePayload]);

    const stashIssueDrag = useCallback(() => {
      setIssueDragStash(buildIssuePayload());
    }, [buildIssuePayload]);

    const { dragHandlers, dragState } = useReferencePillDrag<HTMLDivElement>({
      tabId: `issue-${issue.number}`,
      getPayload: buildIssuePillPayload,
      onPointerDown: stashIssueDrag,
    });

    const treeRowNode: TreeRowNode = useMemo(() => {
      const iconClassName = isOpen ? "text-success-6" : "text-text-3";
      const icon = isOpen ? (
        <CircleDot size={14} strokeWidth={1.75} />
      ) : isCompleted ? (
        <CheckCircle2 size={14} strokeWidth={1.75} />
      ) : (
        <XCircle size={14} strokeWidth={1.75} />
      );

      return {
        id: String(issue.number),
        name: issue.title,
        path: issue.html_url,
        type: "file",
        icon: <span className={iconClassName}>{icon}</span>,
      };
    }, [isOpen, isCompleted, issue.html_url, issue.number, issue.title]);

    return (
      <>
        {dragState && <ReferenceDragGhost dragState={dragState} />}
        <IssueHoverCard issue={issue}>
          <TreeRowBase
            node={treeRowNode}
            depth={depth}
            isSelected={isSelected}
            onClick={onClick}
            showIndentGuides={false}
            onMouseDown={stashIssueDrag}
            {...dragHandlers}
          >
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {issue.comments > 0 && (
                <span
                  className={`flex items-center gap-0.5 ${TYPOGRAPHY.secondary} text-text-3`}
                >
                  <MessageSquare size={11} strokeWidth={1.75} />
                  <span>{issue.comments}</span>
                </span>
              )}

              <span className="min-w-[28px] text-right text-[11px] tabular-nums text-text-3">
                #{issue.number}
              </span>
            </span>
          </TreeRowBase>
        </IssueHoverCard>
      </>
    );
  }
);

IssueRow.displayName = "IssueRow";
