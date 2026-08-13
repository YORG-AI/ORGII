/**
 * discussionCommentForward
 *
 * Turns a human Discussion comment into a Reply turn on the item's
 * linked session, so the Discussion is a live channel instead of a
 * write-only log. The agent is instructed to answer through
 * `org2-pm work note --kind comment` — its reply lands back on the
 * same Discussion, closing the loop. Agent-authored notes arrive via
 * the CLI, never through this UI submit path, so forwarding cannot
 * recurse.
 */
import { projectApi } from "@src/api/http/project";
import type { LinkedSession } from "@src/api/http/project/types/agentWorkflow";
import { SessionService } from "@src/engines/SessionCore/services/SessionService";
import { createLogger } from "@src/hooks/logger";

const logger = createLogger("discussionCommentForward");

/**
 * Latest top-level linked session; sub-agent sessions never own the
 * conversation, so they are skipped.
 */
export function pickForwardTargetSession(
  linkedSessions: LinkedSession[] | undefined
): LinkedSession | null {
  const candidates = (linkedSessions ?? []).filter(
    (session) => !session.parent_session_id
  );
  if (candidates.length === 0) return null;
  return [...candidates].sort((a, b) =>
    (b.started_at ?? "").localeCompare(a.started_at ?? "")
  )[0];
}

export function buildDiscussionForwardMessage({
  shortId,
  author,
  comment,
}: {
  shortId: string;
  author: string;
  comment: string;
}): { content: string; displayText: string } {
  const content = [
    `[Work Item Discussion] ${author} commented on ${shortId}:`,
    "",
    comment,
    "",
    "This is a Reply turn. Answer on the Discussion with exactly one receipt:",
    `  org2-pm work note ${shortId} --kind comment --body "<your reply>"`,
    "(use --body-file for multi-line or shell-sensitive replies)",
    "Do not change status or edit fields unless the comment explicitly asks for it.",
  ].join("\n");
  const displayText = `💬 ${comment}`;
  return { content, displayText };
}

/**
 * One-click retry of a failed linked run: the
 * failed session is resumed with a retry brief so it can finish the
 * remaining work and deliver through org2-pm. Fire-and-forget; failures
 * (session gone, other device) only log.
 */
export async function retryFailedLinkedSession({
  projectSlug,
  orgId,
  shortId,
  sessionId,
}: {
  projectSlug?: string | null;
  orgId?: string | null;
  shortId: string;
  sessionId: string;
}): Promise<void> {
  if (!shortId || !sessionId) return;
  try {
    await projectApi.retryLatestWorkItemRun({
      projectSlug,
      orgId,
      shortId,
      sessionId,
      idempotencyKey: `retry:${shortId}:${sessionId}:${crypto.randomUUID()}`,
    });
    return;
  } catch (error) {
    if (!String(error).includes("PM_RUN_ERR:NOT_FOUND")) {
      logger.warn(`Typed retry for ${sessionId} rejected: ${String(error)}`);
      return;
    }
  }

  // Migration fallback for linked Sessions created before WorkItemRun
  // persistence existed.
  const content = [
    `[Retry] The previous run on ${shortId} did not finish successfully.`,
    "",
    `Re-read the item with \`org2-pm work show ${shortId}\`, finish the remaining work,`,
    "and deliver through org2-pm with exactly one Discussion receipt.",
  ].join("\n");
  try {
    await SessionService.sendMessage({
      sessionId,
      content,
      displayText: `↻ Retry ${shortId}`,
      turnIntentSource: "user_submit",
    });
  } catch (error) {
    logger.warn(`Retry forward to ${sessionId} failed: ${String(error)}`);
  }
}

/**
 * Persist a durable reply Run. Delivery is owned by the backend outbox, so
 * quitting the app after commenting cannot lose or duplicate the turn.
 */
export async function forwardDiscussionCommentToLinkedSession({
  projectSlug,
  orgId,
  shortId,
  commentId,
  authorId,
  author,
  comment,
  linkedSessions,
}: {
  projectSlug?: string | null;
  orgId?: string | null;
  shortId: string;
  commentId: string;
  authorId?: string | null;
  author: string;
  comment: string;
  linkedSessions: LinkedSession[] | undefined;
}): Promise<void> {
  const target = pickForwardTargetSession(linkedSessions);
  if (!target || !shortId) return;
  const { content, displayText } = buildDiscussionForwardMessage({
    shortId,
    author,
    comment,
  });
  try {
    await projectApi.enqueueWorkItemRun({
      projectSlug: projectSlug ?? null,
      orgId: orgId || "personal-org",
      workItemId: shortId,
      trigger: {
        kind: "discussion_comment",
        commentId,
        authorId: authorId ?? null,
      },
      targetSnapshot: {
        target: {
          kind: "resume_session",
          sessionId: target.session_id,
        },
        workItemRevision: 0,
      },
      input: { content, displayText },
      idempotencyKey: `discussion-comment:${commentId}`,
      maxAttempts: 3,
    });
  } catch (error) {
    logger.warn(
      `Discussion Run for ${target.session_id} failed: ${String(error)}`
    );
  }
}
