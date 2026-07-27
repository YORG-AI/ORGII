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
  projectId: string;
  workItemId: string;
}

export type TeamInboxTarget = SessionCommentTarget | WorkItemTarget;

interface TeamInboxItemBase {
  id: string;
  occurredAt: string;
  readAt: string | null;
  actor: TeamInboxActor;
}

export interface CommentMentionItem extends TeamInboxItemBase {
  kind: "comment_mention";
  target: SessionCommentTarget;
  payload: {
    commentBody: string;
    context?: string;
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
  /** Authoritative source totals; absent on lightweight/test data sources. */
  unreadCounts?: {
    all: number;
    mentions: number;
    assigned: number;
  };
}

export interface ListTeamInboxInput {
  cursor?: TeamInboxCursor | null;
  limit?: number;
  signal?: AbortSignal;
}

/**
 * Transport-independent Team Inbox boundary.
 *
 * The feature owns presentation and local selection only. Its host supplies an
 * implementation backed by the canonical comment/work-item read model.
 */
export interface TeamInboxDataSource {
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
      projectId: string;
      workItemId: string;
      action?: "start_agent";
    };
