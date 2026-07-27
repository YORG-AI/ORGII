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
  /** Resolves with the created comment (already inserted); rejects on
   *  failure so composers can keep the draft (design §4 non-goals). */
  addComment: (input: AddCommentInput) => Promise<CloudSessionComment>;
  editComment: (commentId: string, body: string) => Promise<void>;
  deleteComment: (commentId: string) => Promise<void>;
  resolveComment: (
    commentId: string,
    resolved: boolean,
    resolution?: CloudCommentResolution
  ) => Promise<void>;
}
