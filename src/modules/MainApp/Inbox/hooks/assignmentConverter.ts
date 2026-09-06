/**
 * Work Item Assignment → Inbox Notification Converter
 *
 * Converts assignment changes detected by useWorkItemsSource into
 * InboxMessage objects for the inbox system.
 *
 * Flow:
 * 1. useWorkItemsSource detects assignee field changes after a sync/pull
 * 2. The onAssignmentChanges callback fires with the diff
 * 3. This module filters for changes relevant to the current user
 * 4. Matching changes are converted to InboxMessages and upserted
 */
import type { MemberEntry } from "@src/api/http/project";
import type { InboxMessage, MessagePriority } from "@src/api/types/inbox";
import type { AssignmentChange } from "@src/modules/ProjectManager/WorkItems/types";

/** Map work item priority to inbox message priority. Falls back to "medium". */
function toMessagePriority(wiPriority: string): MessagePriority {
  const valid: MessagePriority[] = ["urgent", "high", "medium", "low", "none"];
  return valid.includes(wiPriority as MessagePriority)
    ? (wiPriority as MessagePriority)
    : "medium";
}

/**
 * Build an InboxMessage from an assignment change.
 */
export function assignmentChangeToInboxMessage(
  change: AssignmentChange,
  assignerName: string | undefined,
  isAssigned: boolean
): InboxMessage {
  const now = new Date().toISOString();
  const sender = assignerName || "Team";
  const { shortId, workItemTitle: title, priority: wiPriority } = change;
  const messagePriority = toMessagePriority(wiPriority);

  if (isAssigned) {
    const descriptionBlock = change.description
      ? `\n\n${change.description}`
      : "";
    return {
      id: `wi-assign-${change.workItemId}-${Date.now()}`,
      title: `[${shortId}] ${title}`,
      preview: `${sender} assigned you to this work item`,
      content: `You have been assigned to work item ${title} (${shortId}).${descriptionBlock}`,
      category: "workitems",
      priority: messagePriority,
      status: "unread",
      createdAt: now,
      updatedAt: now,
      sender: { name: sender },
      metadata: {
        projectName: change.projectSlug,
        workItemId: change.shortId,
      },
      labels: [{ id: "assigned", name: "Assigned", color: "#3b82f6" }],
    };
  }

  // Unassigned
  const descriptionBlock = change.description
    ? `\n\n${change.description}`
    : "";
  return {
    id: `wi-unassign-${change.workItemId}-${Date.now()}`,
    title: `[${shortId}] ${title}`,
    preview: "You were unassigned from this work item",
    content: `You have been unassigned from work item ${title} (${shortId}).${descriptionBlock}`,
    category: "workitems",
    priority: messagePriority,
    status: "unread",
    createdAt: now,
    updatedAt: now,
    sender: { name: sender },
    metadata: {
      projectName: change.projectSlug,
      workItemId: change.shortId,
    },
    labels: [{ id: "unassigned", name: "Unassigned", color: "#6b7280" }],
  };
}

/**
 * Filter assignment changes relevant to the current user and convert to InboxMessages.
 *
 * @param changes - All assignment changes detected in this sync
 * @param members - Current members list for resolving IDs to names
 * @param currentUserMemberIds - All member IDs belonging to the current user
 * @returns InboxMessages to upsert into the inbox
 */
export function filterAndConvertAssignmentChanges(
  changes: AssignmentChange[],
  members: MemberEntry[],
  currentUserMemberIds: Set<string>
): InboxMessage[] {
  if (currentUserMemberIds.size === 0) return [];

  const memberMap = new Map(members.map((member) => [member.id, member]));
  const messages: InboxMessage[] = [];

  for (const change of changes) {
    const wasAssignedToMe =
      change.newAssignee !== null &&
      currentUserMemberIds.has(change.newAssignee);
    const wasUnassignedFromMe =
      change.previousAssignee !== null &&
      currentUserMemberIds.has(change.previousAssignee);

    if (wasAssignedToMe) {
      // Someone assigned me — try to figure out who (the previous assignee
      // isn't necessarily the assigner, but it's the best we have without
      // a dedicated "changed_by" field in frontmatter)
      const assignerName = change.previousAssignee
        ? memberMap.get(change.previousAssignee)?.name
        : undefined;
      messages.push(assignmentChangeToInboxMessage(change, assignerName, true));
    } else if (wasUnassignedFromMe) {
      const newAssigneeName = change.newAssignee
        ? memberMap.get(change.newAssignee)?.name
        : undefined;
      messages.push(
        assignmentChangeToInboxMessage(change, newAssigneeName, false)
      );
    }
  }

  return messages;
}
