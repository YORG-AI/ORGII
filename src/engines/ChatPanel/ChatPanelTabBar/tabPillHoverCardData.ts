/**
 * Hover-card payload mapping for chat-panel tabs.
 *
 * Projects the tab-level selection objects onto the shapes the shared
 * WorkItemHoverCard / PrHoverCard components expect.
 */
import type { PrHoverCardData } from "@src/components/PrHoverCard";
import type { WorkItemHoverCardData } from "@src/modules/ProjectManager/WorkItems/components/WorkItemHoverCard";
import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";

export function getWorkItemHoverCardData(
  selection: NonNullable<ChatPanelTab["workItem"]>
): WorkItemHoverCardData {
  const { workItem } = selection;
  return {
    id: workItem.session_id,
    title: workItem.name,
    status: workItem.workItemStatus ?? workItem.status,
    priority: workItem.priority ?? "none",
    projectName: selection.projectName,
    orgName: selection.orgName ?? selection.sourceProject?.orgName,
    source: "local",
    assignee: workItem.assignee,
    labels: workItem.labels,
    createdAt: workItem.created_time,
    updatedAt: workItem.updated_time,
  };
}

export function getPrHoverCardData(
  detail: NonNullable<ChatPanelTab["githubPr"]>
): PrHoverCardData {
  const isDraft = detail.prStatus === "draft";
  return {
    number: detail.prNumber,
    url: detail.prUrl,
    title: detail.prTitle,
    state: isDraft ? "open" : detail.prStatus,
    head_branch: detail.headBranch,
    base_branch: detail.baseBranch,
    draft: isDraft,
    additions: detail.additions,
    deletions: detail.deletions,
    updated_at: detail.updatedAt,
  };
}
