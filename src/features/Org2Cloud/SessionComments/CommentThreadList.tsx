/**
 * CommentThreadList — presentational thread list + composer shared by the
 * turn-anchored inline panels and the session-level notes dialog (design
 * managed-cloud collaboration design).
 *
 * PR-review semantics: flat threads (top-level + one reply level), a
 * three-state status on thread heads (Active / Resolved / Won't fix), edit
 * gated to the author, delete to author/org-admin, tombstones rendered as
 * "comment deleted" so reply chains keep their anchor. The anchor itself
 * (event id / session-level) is baked into `onAdd` by the caller — this
 * component never sees it.
 *
 * Draft restore (design §4 non-goals): composers clear ONLY on a
 * successful add/edit — a failed RPC keeps the text in place and surfaces
 * a toast, which is the local equivalent of the `restoreToInputAtom`
 * cancel-restore pattern (no cross-component atom needed: the composer
 * state never left this component).
 *
 * Agent surface: follow-ups run IN PLACE on the owning session. The literal
 * `@agent ` prefix on the TOP-LEVEL composer runs a personal scoped round
 * (comment-first — the comment posts verbatim through the untouched add
 * path, then the round fires), `kind='agent_report'` replies render as
 * ordinary replies with a tiny agent affix, and a thread whose round is live
 * shows one minimal "Agent is addressing…" line.
 */
import { Bot, Check, Loader2, Pencil, Trash2 } from "lucide-react";
import React, { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Message from "@src/components/Message";
import TextButton from "@src/components/TextButton";
import Textarea from "@src/components/Textarea";
import Tooltip from "@src/components/Tooltip";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import {
  CLOUD_COMMENT_MAX_BODY_LENGTH,
  type CloudCommentResolution,
  type CloudSessionComment,
} from "../org2CloudCommentsClient";
import {
  type CommentThread,
  getThreadResolution,
  isThreadResolved,
} from "../org2CloudSessionCommentsAtom";
import { useSessionCommentsContext } from "./SessionCommentsContext";
import {
  AGENT_COMPOSER_PREFIX,
  detectAgentPrefix,
  shouldShowAgentSuggestion,
  splitAgentMentionBody,
} from "./commentAgentAffordances";

export type CommentThreadStatus = "active" | CloudCommentResolution;

const THREAD_STATUS_OPTIONS: readonly CommentThreadStatus[] = [
  "active",
  "resolved",
  "wont_fix",
];

const THREAD_STATUS_LABEL_KEYS: Record<CommentThreadStatus, string> = {
  active: "cloud.comments.statusActive",
  resolved: "cloud.comments.resolved",
  wont_fix: "cloud.comments.wontFix",
};

export interface CommentThreadListProps {
  threads: CommentThread[];
  viewerUserId: string | null;
  viewerIsAdmin: boolean;
  /** Hide the top-level composer (e.g. the orphaned "earlier version"
   *  bucket, where new anchors would be meaningless). Replies stay. */
  showComposer?: boolean;
  /** Disable the TOP-LEVEL composer with a tooltip (replay-access gate). */
  composerDisabled?: boolean;
  composerDisabledReason?: string;
  composerPlaceholder?: string;
  emptyLabel?: string;
  /**
   * Resolves with the created row when the caller's add path returns it
   * (context surfaces do) — the `@agent ` prefix needs the new comment's
   * id. Undefined = row unknown; the prefix silently skips (comment-first,
   * never comment-blocking).
   */
  onAdd: (
    body: string,
    parentId?: string
  ) => Promise<CloudSessionComment | undefined>;
  onEdit: (commentId: string, body: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
  onResolve: (
    commentId: string,
    resolved: boolean,
    resolution?: CloudCommentResolution
  ) => Promise<void>;
}

interface ComposerProps {
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  disabled?: boolean;
  allowAgentMention?: boolean;
  onSubmit: (body: string) => Promise<void>;
  onCancel?: () => void;
  testId?: string;
}

/** Clears only on success — a failed submit keeps the draft in place. */
const CommentComposer: React.FC<ComposerProps> = ({
  placeholder,
  submitLabel,
  autoFocus = false,
  disabled = false,
  allowAgentMention = false,
  onSubmit,
  onCancel,
  testId,
}) => {
  const { t } = useTranslation("navigation");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const trimmed = body.trim();
  const showAgentSuggestion =
    allowAgentMention && shouldShowAgentSuggestion(body);

  const submit = useCallback(async () => {
    if (!trimmed || busy || disabled) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      setBody("");
    } catch {
      // Draft restore: the text stays in the composer.
      Message.error(t("cloud.comments.addError"));
    } finally {
      setBusy(false);
    }
  }, [trimmed, busy, disabled, onSubmit, t]);

  return (
    <div className="flex flex-col gap-1.5" data-testid={testId}>
      <Textarea
        ref={textareaRef}
        value={body}
        onChange={(value) => setBody(value)}
        placeholder={placeholder}
        size="small"
        autoSize
        rows={2}
        maxLength={CLOUD_COMMENT_MAX_BODY_LENGTH}
        disabled={disabled || busy}
        autoFocus={autoFocus}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
      />
      {showAgentSuggestion ? (
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-md border border-border-2 bg-bg-1 px-2 py-1.5 text-left text-[11px] text-text-2 transition-colors hover:bg-fill-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-6/30"
          data-testid="session-comment-agent-suggestion"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setBody(AGENT_COMPOSER_PREFIX);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
        >
          <Bot size={12} strokeWidth={2} className="text-primary-6" />
          <span className="font-medium">@agent</span>
          <span className="text-text-3">
            {t("cloud.comments.task.mentionSuggestion")}
          </span>
        </button>
      ) : null}
      <div className="flex items-center justify-end gap-1.5">
        {onCancel && (
          <Button
            htmlType="button"
            variant="tertiary"
            size="mini"
            data-testid={testId ? `${testId}-cancel` : undefined}
            onClick={onCancel}
          >
            {t("cloud.comments.cancel")}
          </Button>
        )}
        <Button
          htmlType="button"
          variant="primary"
          size="mini"
          loading={busy}
          disabled={!trimmed || disabled}
          data-testid={testId ? `${testId}-submit` : undefined}
          onClick={() => void submit()}
        >
          {submitLabel}
        </Button>
      </div>
    </div>
  );
};

interface CommentRowProps {
  comment: CloudSessionComment;
  isReply: boolean;
  /** Thread-head verdict; null = active (and always null on replies). */
  resolution: CloudCommentResolution | null;
  viewerUserId: string | null;
  viewerIsAdmin: boolean;
  busy: boolean;
  onEdit: (commentId: string, body: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
  onSetStatus?: (status: CommentThreadStatus) => Promise<void>;
}

const CommentRow: React.FC<CommentRowProps> = ({
  comment,
  isReply,
  resolution,
  viewerUserId,
  viewerIsAdmin,
  busy,
  onEdit,
  onDelete,
  onSetStatus,
}) => {
  const { t } = useTranslation("navigation");
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState("");
  const [rowBusy, setRowBusy] = useState(false);

  const isTombstone = Boolean(comment.deletedAt);
  const isAuthor = Boolean(
    viewerUserId && comment.authorUserId === viewerUserId
  );
  const canEdit = isAuthor && !isTombstone;
  const canDelete = (isAuthor || viewerIsAdmin) && !isTombstone;
  const anyBusy = busy || rowBusy;
  const currentStatus: CommentThreadStatus = resolution ?? "active";
  const agentMention = isReply ? null : splitAgentMentionBody(comment.body);

  const run = useCallback(
    async (operation: () => Promise<void>, errorKey: string) => {
      if (anyBusy) return;
      setRowBusy(true);
      try {
        await operation();
      } catch {
        Message.error(t(errorKey));
      } finally {
        setRowBusy(false);
      }
    },
    [anyBusy, t]
  );

  const saveEdit = useCallback(async () => {
    const trimmed = editBody.trim();
    if (!trimmed) return;
    setRowBusy(true);
    try {
      await onEdit(comment.id, trimmed);
      setEditing(false);
    } catch {
      // Draft restore: the edited text stays in the editor.
      Message.error(t("cloud.comments.addError"));
    } finally {
      setRowBusy(false);
    }
  }, [editBody, onEdit, comment.id, t]);

  return (
    <div
      className={`group/commentrow flex flex-col gap-1 ${isReply ? "ml-5" : ""}`}
      data-testid="session-comment-row"
    >
      <div className="flex items-center gap-1.5 text-[11px] leading-none">
        {comment.kind === "agent_report" ? (
          <span
            className="inline-flex max-w-[180px] items-center gap-1 truncate font-medium text-text-2"
            data-testid="comment-agent-affix"
          >
            <Bot size={11} strokeWidth={2} className="shrink-0 text-text-3" />
            {t("cloud.comments.agentAuthor", {
              name: comment.authorDisplayName ?? comment.authorUserId,
            })}
          </span>
        ) : (
          <span className="max-w-[140px] truncate font-medium text-text-2">
            {comment.authorDisplayName ?? comment.authorUserId}
          </span>
        )}
        <span className="text-text-3">
          {formatRelativeTime(comment.createdAt, "short")}
        </span>
        {comment.editedAt && !isTombstone && (
          <span className="text-text-3">
            ({t("cloud.comments.editedMarker")})
          </span>
        )}
        {!isReply && resolution === "resolved" && (
          <span
            className="inline-flex items-center gap-0.5 text-success-6"
            data-testid="session-comment-resolved-marker"
          >
            <Check size={10} strokeWidth={2.5} />
            {t("cloud.comments.resolved")}
          </span>
        )}
        {!isReply && resolution === "wont_fix" && (
          <span
            className="inline-flex items-center gap-0.5 text-text-3"
            data-testid="session-comment-wontfix-marker"
          >
            {t("cloud.comments.wontFix")}
          </span>
        )}
        <span className="ml-auto inline-flex items-center gap-0.5 opacity-0 transition-opacity group-focus-within/commentrow:opacity-100 group-hover/commentrow:opacity-100">
          {!isReply && onSetStatus && (
            <span
              className="inline-flex items-center overflow-hidden rounded border border-border-2"
              data-testid="session-comment-status"
            >
              {THREAD_STATUS_OPTIONS.map((status) => (
                <button
                  key={status}
                  type="button"
                  disabled={anyBusy}
                  aria-pressed={status === currentStatus}
                  data-testid={`session-comment-status-${status}`}
                  className={`px-1.5 py-0.5 text-[10px] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-6/30 ${
                    status === currentStatus
                      ? "bg-fill-2 font-medium text-text-1"
                      : "text-text-3 hover:bg-fill-1 hover:text-text-1"
                  }`}
                  onClick={() => {
                    if (status === currentStatus) return;
                    void run(
                      () => onSetStatus(status),
                      "cloud.comments.actionError"
                    );
                  }}
                >
                  {t(THREAD_STATUS_LABEL_KEYS[status])}
                </button>
              ))}
            </span>
          )}
          {canEdit && (
            <Tooltip content={t("cloud.comments.edit")} framedPanel>
              <Button
                htmlType="button"
                variant="tertiary"
                size="mini"
                iconOnly
                disabled={anyBusy}
                aria-label={t("cloud.comments.edit")}
                data-testid="session-comment-edit"
                icon={<Pencil size={12} strokeWidth={2} />}
                onClick={() => {
                  setEditBody(comment.body);
                  setEditing(true);
                }}
              />
            </Tooltip>
          )}
          {canDelete && (
            <Tooltip content={t("cloud.comments.delete")} framedPanel>
              <Button
                htmlType="button"
                variant="tertiary"
                size="mini"
                iconOnly
                disabled={anyBusy}
                aria-label={t("cloud.comments.delete")}
                data-testid="session-comment-delete"
                icon={<Trash2 size={12} strokeWidth={2} />}
                onClick={() =>
                  void run(
                    () => onDelete(comment.id),
                    "cloud.comments.actionError"
                  )
                }
              />
            </Tooltip>
          )}
        </span>
      </div>
      {editing ? (
        <div className="flex flex-col gap-1.5">
          <Textarea
            value={editBody}
            onChange={(value) => setEditBody(value)}
            size="small"
            autoSize
            rows={2}
            maxLength={CLOUD_COMMENT_MAX_BODY_LENGTH}
            disabled={rowBusy}
            autoFocus
          />
          <div className="flex items-center justify-end gap-1.5">
            <Button
              htmlType="button"
              variant="tertiary"
              size="mini"
              data-testid="session-comment-edit-cancel"
              onClick={() => setEditing(false)}
            >
              {t("cloud.comments.cancel")}
            </Button>
            <Button
              htmlType="button"
              variant="primary"
              size="mini"
              loading={rowBusy}
              disabled={!editBody.trim()}
              data-testid="session-comment-edit-save"
              onClick={() => void saveEdit()}
            >
              {t("cloud.comments.save")}
            </Button>
          </div>
        </div>
      ) : isTombstone ? (
        <div className="text-[12px] italic text-text-3">
          {t("cloud.comments.deletedComment")}
        </div>
      ) : (
        <div className="whitespace-pre-wrap break-words text-[12px] text-text-1">
          {agentMention ? (
            <>
              <span
                className="mr-1 inline-flex items-center gap-1 rounded-full border border-primary-3 bg-primary-1 px-1.5 py-0.5 align-middle text-[10px] font-medium leading-none text-primary-7"
                data-testid="comment-agent-mention-pill"
                aria-label={agentMention.mention}
              >
                <Bot size={10} strokeWidth={2.25} aria-hidden="true" />
                {agentMention.mention}
              </span>
              {agentMention.brief}
            </>
          ) : (
            comment.body
          )}
        </div>
      )}
    </div>
  );
};

interface ThreadBlockProps {
  thread: CommentThread;
  viewerUserId: string | null;
  viewerIsAdmin: boolean;
  onAdd: CommentThreadListProps["onAdd"];
  onEdit: CommentThreadListProps["onEdit"];
  onDelete: CommentThreadListProps["onDelete"];
  onResolve: CommentThreadListProps["onResolve"];
}

const ThreadBlock: React.FC<ThreadBlockProps> = ({
  thread,
  viewerUserId,
  viewerIsAdmin,
  onAdd,
  onEdit,
  onDelete,
  onResolve,
}) => {
  const { t } = useTranslation("navigation");
  const context = useSessionCommentsContext();
  const [replying, setReplying] = useState(false);
  const resolution = getThreadResolution(thread);

  const addressing = Boolean(
    context?.addressRunActive &&
    resolution === null &&
    (context.addressRunSelectedHeadIds === null ||
      context.addressRunSelectedHeadIds.has(thread.top.id))
  );

  const setStatus = useCallback(
    (status: CommentThreadStatus): Promise<void> =>
      status === "active"
        ? onResolve(thread.top.id, false)
        : onResolve(thread.top.id, true, status),
    [onResolve, thread.top.id]
  );

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border-1 bg-bg-2 px-2.5 py-2">
      <CommentRow
        comment={thread.top}
        isReply={false}
        resolution={resolution}
        viewerUserId={viewerUserId}
        viewerIsAdmin={viewerIsAdmin}
        busy={false}
        onEdit={onEdit}
        onDelete={onDelete}
        onSetStatus={setStatus}
      />
      {addressing && (
        <div
          className="flex items-center gap-1.5 text-[11px] text-text-3"
          data-testid="comment-thread-agent-status"
          data-run-state="active"
        >
          <Loader2 size={12} strokeWidth={2} className="animate-spin" />
          {t("cloud.comments.agentAddressing")}
        </div>
      )}
      {thread.replies.map((reply) => (
        <CommentRow
          key={reply.id}
          comment={reply}
          isReply
          resolution={null}
          viewerUserId={viewerUserId}
          viewerIsAdmin={viewerIsAdmin}
          busy={false}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      ))}
      {replying ? (
        <div className="ml-5">
          <CommentComposer
            placeholder={t("cloud.comments.replyPlaceholder")}
            submitLabel={t("cloud.comments.reply")}
            autoFocus
            onSubmit={async (body) => {
              await onAdd(body, thread.top.id);
              setReplying(false);
            }}
            onCancel={() => setReplying(false)}
            testId="session-comment-reply-composer"
          />
        </div>
      ) : (
        <TextButton
          className="self-start text-[11px] text-text-3 hover:text-text-1"
          data-testid="session-comment-reply"
          onClick={() => setReplying(true)}
        >
          {t("cloud.comments.reply")}
        </TextButton>
      )}
    </div>
  );
};

const CommentThreadList: React.FC<CommentThreadListProps> = ({
  threads,
  viewerUserId,
  viewerIsAdmin,
  showComposer = true,
  composerDisabled = false,
  composerDisabledReason,
  composerPlaceholder,
  emptyLabel,
  onAdd,
  onEdit,
  onDelete,
  onResolve,
}) => {
  const { t } = useTranslation("navigation");
  const context = useSessionCommentsContext();
  const [showResolved, setShowResolved] = useState(false);

  const openThreads = threads.filter((thread) => !isThreadResolved(thread));
  const resolvedThreads = threads.filter(isThreadResolved);

  const requestAgent = context?.requestAgent;
  const submitTopLevel = useCallback(
    async (body: string): Promise<void> => {
      const comment = await onAdd(body);
      // Beyond here the comment IS posted — never throw (a throw would
      // trigger the composer's draft restore for a send that succeeded).
      if (!comment || comment.parentId) return;
      if (!detectAgentPrefix(body)) return;
      if (!requestAgent || !context?.canRunAgent) {
        // Read-only/imported surfaces treat a manually typed @agent prefix as
        // ordinary comment text. There is no assignment, toast or side effect.
        return;
      }
      // Comment-first (design §4 item 2): the body landed VERBATIM above,
      // so a failed create degrades to a normal thread — and create is
      // idempotent per comment (retry-safe by re-sending `@agent `).
      try {
        await requestAgent(comment.id);
      } catch {
        Message.warning(t("cloud.comments.task.assignFailed"));
      }
    },
    [onAdd, requestAgent, context?.canRunAgent, t]
  );

  const composer = showComposer ? (
    <CommentComposer
      placeholder={composerPlaceholder ?? t("cloud.comments.addPlaceholder")}
      submitLabel={t("cloud.comments.send")}
      disabled={composerDisabled}
      allowAgentMention={Boolean(requestAgent && context?.canRunAgent)}
      onSubmit={submitTopLevel}
      testId="session-comment-composer"
    />
  ) : null;

  return (
    <div className="flex flex-col gap-2">
      {threads.length === 0 && emptyLabel && (
        <div className="text-[12px] text-text-3">{emptyLabel}</div>
      )}
      {openThreads.map((thread) => (
        <ThreadBlock
          key={thread.top.id}
          thread={thread}
          viewerUserId={viewerUserId}
          viewerIsAdmin={viewerIsAdmin}
          onAdd={onAdd}
          onEdit={onEdit}
          onDelete={onDelete}
          onResolve={onResolve}
        />
      ))}
      {resolvedThreads.length > 0 && (
        <TextButton
          className="self-start text-[11px] text-text-3 hover:text-text-1"
          data-testid="session-comment-resolved-toggle"
          onClick={() => setShowResolved((current) => !current)}
        >
          {t("cloud.comments.resolvedToggle", {
            count: resolvedThreads.length,
          })}
        </TextButton>
      )}
      {showResolved &&
        resolvedThreads.map((thread) => (
          <ThreadBlock
            key={thread.top.id}
            thread={thread}
            viewerUserId={viewerUserId}
            viewerIsAdmin={viewerIsAdmin}
            onAdd={onAdd}
            onEdit={onEdit}
            onDelete={onDelete}
            onResolve={onResolve}
          />
        ))}
      {composer &&
        (composerDisabled && composerDisabledReason ? (
          <Tooltip content={composerDisabledReason} framedPanel>
            <div>{composer}</div>
          </Tooltip>
        ) : (
          composer
        ))}
    </div>
  );
};

export default CommentThreadList;
