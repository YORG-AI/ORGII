export type WorkItemContentPresentation = "default" | "thread";

export interface WorkItemContentSectionPolicy {
  showTabbedLowerSection: boolean;
  showLinkedSessionsTable: boolean;
  showInlineWorkflow: boolean;
  showInlineOutput: boolean;
  showInlineHistory: boolean;
}

/**
 * Keep the Work Item presentation policy explicit and testable.
 *
 * The default surface retains its existing tabs/table. Team Inbox uses the
 * thread policy: workflow/session cards and activity are inline, while the
 * duplicate linked-session table is absent.
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
      showInlineHistory: true,
    };
  }

  return {
    showTabbedLowerSection: true,
    showLinkedSessionsTable: true,
    showInlineWorkflow: false,
    showInlineOutput: false,
    showInlineHistory: false,
  };
}
