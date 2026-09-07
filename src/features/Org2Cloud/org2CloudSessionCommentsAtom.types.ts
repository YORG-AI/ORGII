/**
 * Type surface for `org2CloudSessionCommentsAtom.ts` (the session-comments
 * atom + `useSessionComments` hook). Split out so sibling extraction
 * modules (`org2CloudSessionCommentsAtom.commentTransforms.ts`) can depend
 * on the shared shapes without importing the hook implementation itself.
 */
import type {
  CloudCommentResolution,
  CloudSessionComment,
} from "./org2CloudCommentsClient";

export type SessionCommentDeliveryStatus = "pending" | "sent" | "failed";

/**
 * Named alias for the canonical comment row. Transient delivery state
 * (`clientDeliveryStatus`, `clientDeliveryError`, the retry CAS anchors)
 * lives on `CloudSessionComment` itself — there is no second row shape.
 */
export type SessionComment = CloudSessionComment;

export type CloudSessionCommentsFetchState =
  | "idle"
  | "loading"
  | "ready"
  | "error";

export interface CloudSessionCommentsEntry {
  /** Prevents cached bodies from crossing an account or endpoint switch. */
  identityKey?: string;
  comments: CloudSessionComment[];
  /** Server-derived permission for spending this session owner's local model. */
  viewerOwnsSession: boolean;
  state: CloudSessionCommentsFetchState;
  /** Last fetch failure (diagnostics only — UI keys on `state`). */
  errorMessage?: string;
  /** Consecutive failed fetches; drives the exponential error-retry window. */
  consecutiveFailures?: number;
  /** Epoch ms of the last completed fetch attempt (0 ⇒ never fetched). */
  fetchedAt: number;
  /**
   * The last listing's 0004 `serverTime` anchor. TTL refetches pull the
   * delta behind it (minus the safety overlap); absent — legacy backend or
   * never fetched — every listing stays full.
   */
  lastServerTime?: string;
}

export type SessionCommentsFetchDecision = "claim" | "skip" | "queue_force";

export interface CommentThread {
  top: CloudSessionComment;
  /** Direct replies, (createdAt, id) asc. Flat: replies never nest. */
  replies: CloudSessionComment[];
}

export interface GroupedCommentThreads {
  /** Threads anchored to a PRESENT event id, keyed by that id. */
  byEventId: Map<string, CommentThread[]>;
  /** Unanchored session-level notes. */
  sessionLevel: CommentThread[];
  /**
   * Threads whose anchor event no longer exists in the local replay stream
   * (owner-side epoch rewrite dropped it). Rendered in an "earlier version"
   * bucket — never crash, never silently vanish.
   */
  orphaned: CommentThread[];
}

export interface AddCommentInput {
  body: string;
  eventId?: string;
  parentId?: string;
  /** Active cloud-org members explicitly notified by this comment. */
  mentionedUserIds?: string[];
  /**
   * Stable client id for admission recovery and explicit retries. It is also
   * the Cloud RPC idempotency key, so a lost response cannot create a second
   * durable comment when the same failed row is retried.
   */
  optimisticId?: string;
  /** The user edited a previously failed row before retrying it. */
  replaceExisting?: boolean;
  /** Original failed-row body for an edited retry's server-side CAS. */
  expectedBody?: string;
  /** Original failed-row mentions for an edited retry's server-side CAS. */
  expectedMentionedUserIds?: string[];
}

/**
 * The send failed AFTER the optimistic row was retained as a visible failed
 * row. `commentId` is that row's stable local id — the same `optimisticId`
 * the owning surface re-sends under. A plain rejection means nothing was
 * retained and the caller still owns the only copy of the user's text.
 */
export class SessionCommentDeliveryError extends Error {
  readonly commentId: string;
  readonly cause: unknown;

  constructor(commentId: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SessionCommentDeliveryError";
    this.commentId = commentId;
    this.cause = cause;
  }
}

export interface UseSessionCommentsResult {
  comments: CloudSessionComment[];
  viewerOwnsSession: boolean;
  state: CloudSessionCommentsFetchState;
  /** Refetch now, ignoring the TTL. */
  refresh: () => void;
  /**
   * Local-only insert of a server-shaped comment row — the complete RPC
   * returns its `agent_report` reply byte-identical to a list entry
   * (add/list parity rule), so the runner bridge inserts it without a
   * refetch. No RPC fires; the next TTL refetch reconciles regardless.
   */
  insertLocalComment: (comment: CloudSessionComment) => void;
  /**
   * Resolves with the created comment (already inserted). On a transport
   * rejection the optimistic row stays visible as failed — body and mention
   * pills intact — and the rejection is a `SessionCommentDeliveryError`
   * naming that row, so the caller must not restore its draft. Retry is not
   * a separate operation: the owning surface calls `addComment` again with
   * the same `optimisticId` (plus the `replaceExisting`/`expected*` CAS
   * anchors when the user edited the text first).
   */
  addComment: (input: AddCommentInput) => Promise<CloudSessionComment>;
  editComment: (commentId: string, body: string) => Promise<void>;
  deleteComment: (commentId: string) => Promise<void>;
  resolveComment: (
    commentId: string,
    resolved: boolean,
    resolution?: CloudCommentResolution
  ) => Promise<void>;
}
