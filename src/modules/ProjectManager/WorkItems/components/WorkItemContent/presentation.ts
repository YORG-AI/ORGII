export type WorkItemContentPresentation = "default" | "thread";

export interface WorkItemContentSectionPolicy {
  showTabbedLowerSection: boolean;
  showLinkedSessionsTable: boolean;
  showInlineOutput: boolean;
}

/**
 * Keep the Work Item presentation policy explicit and testable.
 *
 * The default surface retains its existing tabs/table. Team Inbox uses the
 * thread policy: the linked-session table stays in Overview, local Discussion
 * is a drill-in view. GitHub issues supply their native floating comment
 * composer separately.
 */
export function resolveWorkItemContentSectionPolicy(
  presentation: WorkItemContentPresentation,
  hasProofOfWork: boolean
): WorkItemContentSectionPolicy {
  if (presentation === "thread") {
    return {
      showTabbedLowerSection: false,
      showLinkedSessionsTable: true,
      showInlineOutput: hasProofOfWork,
    };
  }

  return {
    showTabbedLowerSection: true,
    showLinkedSessionsTable: true,
    showInlineOutput: false,
  };
}
