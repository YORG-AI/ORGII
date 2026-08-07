/** Pure predicates behind the thread-list / turn-chrome agent affordances. */
import type {
  CloudCommentTask,
  CloudCommentTaskState,
} from "../org2CloudCommentTasksClient";
import type { CommentThread } from "../org2CloudSessionCommentsAtom";

/**
 * The composer sugar token (design §1): promotion is EXPLICIT — a literal
 * prefix over the same create RPC, never NL intent detection.
 */
export const AGENT_COMPOSER_PREFIX = "@agent ";

/**
 * Literal `@agent ` detection on the SUBMITTED body (composers trim before
 * submit): case-sensitive, anchored at index 0 (no leading-whitespace
 * tolerance — a trimmed body can't have any), and the trailing space is
 * part of the token, so "@agents please" and a bare "@agent" are ordinary
 * comments. The prefix must be followed by content: the comment posts
 * VERBATIM and an empty brief would promote a thread that says nothing.
 */
export function detectAgentPrefix(body: string): boolean {
  return (
    body.startsWith(AGENT_COMPOSER_PREFIX) &&
    body.slice(AGENT_COMPOSER_PREFIX.length).trim().length > 0
  );
}

export interface AgentMentionBodyParts {
  mention: "@agent";
  brief: string;
}

/**
 * Splits the submitted sugar into a semantic mention token and its brief.
 * Keeping this beside the detector ensures the rendered pill and task
 * creation always use the exact same grammar.
 */
export function splitAgentMentionBody(
  body: string
): AgentMentionBodyParts | null {
  if (!detectAgentPrefix(body)) return null;
  return {
    mention: "@agent",
    brief: body.slice(AGENT_COMPOSER_PREFIX.length),
  };
}

/**
 * "Live" for the turn badge (design §4 item 3) = open/claimed/running.
 * Lease-expired claimed/running rows COUNT: their state is still live and
 * the task is one reclaim away from running — the badge advertises "an
 * agent is (to be) on this turn", not lease health.
 */
const LIVE_TASK_STATES: ReadonlySet<CloudCommentTaskState> = new Set([
  "open",
  "claimed",
  "running",
]);

export function isLiveTaskState(state: CloudCommentTaskState): boolean {
  return LIVE_TASK_STATES.has(state);
}

/**
 * TurnCommentChrome badge predicate: any of the turn's threads carries a
 * live task. Tasks key on the thread HEAD (UNIQUE `comment_id` — replies
 * are never promoted), so only `thread.top.id` is ever looked up.
 */
export function threadsHaveLiveAgentTask(
  threads: readonly CommentThread[],
  taskForThread: (commentId: string) => CloudCommentTask | undefined
): boolean {
  return threads.some((thread) => {
    const task = taskForThread(thread.top.id);
    return task !== undefined && isLiveTaskState(task.state);
  });
}
