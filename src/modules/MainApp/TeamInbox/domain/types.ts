import type { WorkItemHandoff } from "@src/api/http/project";

export type TeamInboxFilter = "all" | "mentions" | "assigned";

export interface TeamInboxActor {
  id: string;
  displayName: string;
  avatarUrl?: string;
}

export interface SessionCommentTarget {
  kind: "session_comment";
  sessionId: string;
  sessionTitle: string;
  commentId: string;
  threadId: string;
  anchor?: string;
}

export interface WorkItemTarget {
  kind: "work_item";
  /** Owning project-org id; legacy/test rows may omit it. */
  orgId?: string;
  projectId: string;
  workItemId: string;
  /** First repository in the owning project's synced-repository scope. */
  repository?: string;
}

export interface WorkItemCommentTarget {
  kind: "work_item_comment";
  orgId?: string;
  projectId: string;
  workItemId: string;
  commentId: string;
  workItemTitle: string;
}

export type TeamInboxTarget =
  | SessionCommentTarget
  | WorkItemTarget
  | WorkItemCommentTarget;

interface TeamInboxItemBase {
  id: string;
  occurredAt: string;
  readAt: string | null;
  actor: TeamInboxActor;
}

export interface CommentMentionItem extends TeamInboxItemBase {
  kind: "comment_mention";
  target: SessionCommentTarget | WorkItemCommentTarget;
  payload: {
    commentBody: string;
    context?: string;
    /** Structured cloud value; presentation localizes it at render time. */
    threadCommentCount?: number;
    commentCount: number;
  };
}

export interface AssignedWorkItem extends TeamInboxItemBase {
  kind: "assigned_work_item";
  target: WorkItemTarget;
  payload: {
    title: string;
    status: string;
    priority: string;
    /** Raw member id from the read model; the stable assignee identity. */
    assigneeMemberId: string;
    /** Display name resolved from project members; absent until resolved. */
    assigneeName?: string;
    summary?: string;
    updatedAt: string;
    handoff?: WorkItemHandoff;
  };
}

export type TeamInboxItem = CommentMentionItem | AssignedWorkItem;

export interface TeamInboxCursor {
  occurredAt: string;
  itemKey: string;
}

export interface TeamInboxPage {
  items: TeamInboxItem[];
  nextCursor: TeamInboxCursor | null;
  /** True when this snapshot was synchronously cleared for a new scope. */
  loading?: boolean;
  /** Non-fatal or fatal source condition associated with this snapshot. */
  issue?: TeamInboxIssue | null;
  /** Authoritative source totals; absent on lightweight/test data sources. */
  unreadCounts?: {
    all: number;
    mentions: number;
    assigned: number;
  };
}

export type TeamInboxIssueCode =
  | "identity_unresolved"
  | "load_failed"
  | "partial_load";

export interface TeamInboxIssue {
  code: TeamInboxIssueCode;
  /** Diagnostic detail for logs/support; UI copy is derived from `code`. */
  detail?: string;
}

export interface ListTeamInboxInput {
  cursor?: TeamInboxCursor | null;
  limit?: number;
  signal?: AbortSignal;
}

export interface TeamInboxSessionDropInput {
  sessionId: string;
  title: string;
  destinationKey: string;
  assigneeMemberId: string;
  status: import("@src/types/core/workItem").WorkItemStatus;
  priority: import("@src/types/core/workItem").WorkItemPriority;
  targetDate?: string;
  handoffNote?: string;
  signal?: AbortSignal;
}

export interface TeamInboxHandoffMember {
  id: string;
  name: string;
  avatar?: string;
  isCurrentUser: boolean;
}

interface TeamInboxHandoffDestinationBase {
  key: string;
  name: string;
  sender: TeamInboxHandoffMember;
  recipients: TeamInboxHandoffMember[];
}

export interface TeamInboxProjectHandoffDestination extends TeamInboxHandoffDestinationBase {
  kind: "project";
  projectId: string;
  projectSlug: string;
}

export interface TeamInboxCloudOrgHandoffDestination extends TeamInboxHandoffDestinationBase {
  kind: "cloud_org";
  orgId: string;
}

export type TeamInboxHandoffDestination =
  | TeamInboxProjectHandoffDestination
  | TeamInboxCloudOrgHandoffDestination;

export interface TeamInboxSessionHandoffDraft {
  sessionId: string;
  title: string;
  sourceDestinationKey?: string;
  destinations: TeamInboxHandoffDestination[];
  requestPreview?: string;
  impactSummary?: string;
  todoCount: number;
}

export interface TeamInboxCreatedWorkItem {
  orgId?: string;
  projectId: string;
  workItemId: string;
  reused: boolean;
}

/**
 * Transport-independent Team Inbox boundary.
 *
 * The feature owns presentation and local selection only. Its host supplies an
 * implementation backed by the canonical comment/work-item read model.
 */
export interface TeamInboxDataSource {
  /**
   * Returns the last bounded snapshot synchronously when one is available.
   * The view uses this on mount so switching tabs never replaces a usable
   * Inbox list with a loading frame while the same scope revalidates.
   */
  getSnapshot?(): TeamInboxPage;
  /**
   * Stable identity for the current viewer/org scope. It changes only when the
   * backing scope changes, not on ordinary memo recreation or refresh.
   */
  scopeKey?: string;
  listPage(input: ListTeamInboxInput): Promise<TeamInboxPage>;
  markRead?(item: TeamInboxItem): Promise<void>;
  markUnread?(item: TeamInboxItem): Promise<void>;
  markAllRead?(
    items: readonly TeamInboxItem[],
    filter?: TeamInboxFilter
  ): Promise<void>;
  refresh?(): Promise<void>;
  /**
   * Loads the next page from every source that still has one and appends the
   * results to the current page. A no-op when nothing more is available.
   */
  loadMore?(): Promise<void>;
  subscribe?(listener: () => void): () => void;
  /**
   * Reconciles a detail-side projection into the canonical list snapshot.
   * `nextItem = null` removes an item that no longer belongs to this viewer.
   */
  reconcileItem?(itemKey: string, nextItem: TeamInboxItem | null): void;
  /**
   * Creates a Work Item from a one-time Session snapshot. The implementation
   * owns persistence, idempotency, and source linkage.
   */
  createWorkItemFromSession?(
    input: TeamInboxSessionDropInput
  ): Promise<TeamInboxCreatedWorkItem>;
  prepareSessionHandoff?(
    input: Pick<TeamInboxSessionDropInput, "sessionId" | "title" | "signal">
  ): Promise<TeamInboxSessionHandoffDraft>;
}

export type TeamInboxNavigationIntent =
  | {
      kind: "open_session";
      sessionId: string;
    }
  | {
      kind: "open_session_comment";
      sessionId: string;
      commentId: string;
      threadId: string;
      anchor?: string;
    }
  | {
      kind: "open_work_item";
      orgId?: string;
      projectId: string;
      workItemId: string;
    };
