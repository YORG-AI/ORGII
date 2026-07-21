export interface WorkItemDetailPageProps {
  projectId?: string;
  projectName?: string;
  projectSlug?: string;
  workItemId: string;
  onClose: () => void;
  /** Open an agent session in a chat tab. */
  onOpenChatSession?: (sessionId: string, title?: string) => void;
  /** Unsaved changes transferred from the inline detail panel. */
  pendingUpdates?: Record<string, unknown>;
  /** Publish page header into the global WorkstationTabHeader. */
  publishHeaderToWorkstation?: boolean;
  /** Notify the parent tab system when the work item title changes. */
  onWorkItemNameUpdated?: (workItemName: string) => void;
}
