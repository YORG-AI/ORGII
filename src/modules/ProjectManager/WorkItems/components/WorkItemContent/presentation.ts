export type WorkItemContentPresentation = "default" | "thread";

export interface WorkItemContentSectionPolicy {
  showTabbedLowerSection: boolean;
  showLinkedSessionsTable: boolean;
  showInlineWorkflow: boolean;
  showInlineOutput: boolean;
}

/**
 * Keep the Work Item presentation policy explicit and testable.
 *
 * The default surface retains its existing tabs/table. Team Inbox uses the
 * thread policy: workflow/session cards stay in Overview, local Discussion is
 * a drill-in view, and the duplicate linked-session table is absent. GitHub
 * issues supply their native floating comment composer separately.
 */
export function resolveWorkItemContentSectionPolicy(
  presentation: WorkItemContentPresentation,
  hasProofOfWork: boolean
): WorkItemContentSectionPolicy {
  if (presentation === "thread") {
    return {
      showTabbedLowerSection: false,
      showLinkedSessionsTable: false,
      showInlineWorkflow: true,
      showInlineOutput: hasProofOfWork,
    };
  }

  return {
    showTabbedLowerSection: true,
    showLinkedSessionsTable: true,
    showInlineWorkflow: false,
    showInlineOutput: false,
  };
}
