/**
 * SessionCommentsHeaderExtras — chat-panel header entry for SESSION-LEVEL
 * notes (managed-cloud collaboration design), a sibling of
 * SessionForkHeaderExtras so the header prop plumbing stays one ReactNode.
 *
 * Note icon + live-note count; clicking opens a dialog with the
 * session-level threads + composer, plus the "earlier version" bucket of
 * orphaned turn anchors (threads whose anchor event an owner-side epoch
 * rewrite dropped — degrade gracefully, never vanish). metadata_only
 * sessions get ONLY this surface: session-level notes need no replay
 * access, so the composer here is never replay-gated.
 *
 * Runs its own `useSessionComments` instance (the header mounts OUTSIDE
 * the ChatView provider tree); the atom entry is shared, so no duplicate
 * fetches beyond the TTL guard. Orphan bucketing reads the replay
 * stream's event ids from the registry the provider publishes
 * (`sessionCommentPresentEventIdsAtom`).
 */
import Modal from "@/src/scaffold/ModalSystem";
import { useAtomValue } from "jotai";
import { StickyNote } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Tooltip from "@src/components/Tooltip";
import type { Session } from "@src/store/session/sessionAtom/types";

import { getSessionForkedFrom } from "../../TeamCollaboration/forkSession";
import {
  countLiveComments,
  groupCommentThreads,
  mergePresentEventIdEntries,
  useSessionComments,
} from "../org2CloudSessionCommentsAtom";
import { useSessionCommentTarget } from "../sessionCommentTarget";
import CommentThreadList from "./CommentThreadList";
import {
  sessionCommentPresentEventIdsAtom,
  useSessionCommentMentionableMembers,
  useSessionCommentViewer,
} from "./SessionCommentsContext";

export interface SessionCommentsHeaderExtrasProps {
  session: Session | null;
}

const SessionCommentsHeaderExtras: React.FC<
  SessionCommentsHeaderExtrasProps
> = ({ session }) => {
  const { t } = useTranslation("navigation");
  const target = useSessionCommentTarget(session);
  const {
    comments,
    state,
    addComment,
    editComment,
    deleteComment,
    resolveComment,
  } = useSessionComments(
    target?.orgId ?? null,
    target?.sessionId ?? null,
    // Only a writable fork stamps an origin; imports/tagged coalesce to source.
    session && getSessionForkedFrom(session)
      ? (session.session_id ?? null)
      : null
  );
  const viewer = useSessionCommentViewer(target);
  const mentionableMembers = useSessionCommentMentionableMembers(target);
  const presentRegistry = useAtomValue(sessionCommentPresentEventIdsAtom);
  const [open, setOpen] = useState(false);

  // The registry is keyed session → provider instance (split panes on the
  // SAME session each publish their own entry); union the instances — any
  // surviving pane keeps orphan bucketing alive after the other closes.
  const presentEntries = session
    ? presentRegistry[session.session_id]
    : undefined;
  const presentEventIds = useMemo(
    () => mergePresentEventIdEntries(presentEntries),
    [presentEntries]
  );
  const grouped = useMemo(
    () => groupCommentThreads(comments, presentEventIds),
    [comments, presentEventIds]
  );

  const handleAddNote = useCallback(
    async (body: string, parentId?: string, mentionedUserIds?: string[]) =>
      // Session-level notes carry NO anchor; replies inherit the parent's.
      // Returning the row satisfies the list's onAdd contract; the agent
      // affordances stay dormant here regardless (no provider ⇒ null
      // context in this dialog's tree).
      addComment(
        parentId
          ? { body, parentId, mentionedUserIds }
          : { body, mentionedUserIds }
      ),
    [addComment]
  );
  const handleReplyOnly = useCallback(
    async (body: string, parentId?: string, mentionedUserIds?: string[]) => {
      if (!parentId) return undefined;
      return addComment({ body, parentId, mentionedUserIds });
    },
    [addComment]
  );

  if (!session || !target) return null;

  const noteCount = countLiveComments(grouped.sessionLevel);
  const buttonLabel = t("cloud.comments.notesButton");

  return (
    <>
      <Tooltip
        content={buttonLabel}
        position="bottom-end"
        mouseEnterDelay={200}
        framedPanel
      >
        <span className="relative inline-flex">
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            iconOnly
            onClick={() => setOpen(true)}
            aria-label={buttonLabel}
            data-testid="session-notes-button"
            icon={<StickyNote size={14} strokeWidth={2} />}
          />
          {noteCount > 0 && (
            <span
              className="pointer-events-none absolute -right-0.5 -top-0.5 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full bg-primary-6 px-0.5 text-[9px] font-medium leading-none text-white"
              data-testid="session-notes-count"
            >
              {noteCount}
            </span>
          )}
        </span>
      </Tooltip>
      <Modal
        visible={open}
        title={t("cloud.comments.notesTitle")}
        onCancel={() => setOpen(false)}
        footer={null}
        width={480}
      >
        <div
          className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto"
          data-testid="session-comment-thread"
        >
          <CommentThreadList
            threads={grouped.sessionLevel}
            viewerUserId={viewer.viewerUserId}
            viewerIsAdmin={viewer.viewerIsAdmin}
            mentionableMembers={mentionableMembers}
            emptyLabel={
              state === "error"
                ? t("cloud.comments.loadError")
                : t("cloud.comments.empty")
            }
            onAdd={handleAddNote}
            onEdit={editComment}
            onDelete={deleteComment}
            onResolve={resolveComment}
          />
          {grouped.orphaned.length > 0 && (
            <div
              className="flex flex-col gap-2 border-t border-border-1 pt-2"
              data-testid="session-comment-orphans"
            >
              <div className="text-[11px] text-text-3">
                {t("cloud.comments.earlierVersion")}
              </div>
              <CommentThreadList
                threads={grouped.orphaned}
                viewerUserId={viewer.viewerUserId}
                viewerIsAdmin={viewer.viewerIsAdmin}
                mentionableMembers={mentionableMembers}
                // New top-level anchors into a dropped event would be
                // meaningless — replies/resolve on existing threads stay.
                showComposer={false}
                onAdd={handleReplyOnly}
                onEdit={editComment}
                onDelete={deleteComment}
                onResolve={resolveComment}
              />
            </div>
          )}
        </div>
      </Modal>
    </>
  );
};

export default SessionCommentsHeaderExtras;
