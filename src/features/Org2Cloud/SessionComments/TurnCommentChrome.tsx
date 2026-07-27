/**
 * TurnCommentChrome — per-turn comment affordance + inline thread panel in
 * the replay transcript (managed-cloud collaboration design).
 *
 * Rendered by `GroupHeaderRenderer` around each turn's user-message card;
 * its toggle is injected into the card's existing action toolbar while the
 * expanding thread remains below the card. The anchor id is the turn's
 * leading user-message event id (the same stable id `useChatGroups` exposes
 * as `turnId`). Consumes
 * `SessionCommentsContext` — a null context (any non-cloud session, or a
 * surface without the provider) adds no chrome, so the ordinary chat panel
 * is untouched. The expanding panel lives inside the group row,
 * which is height-measured by a ResizeObserver in both list paths, so
 * virtualization stays correct.
 */
import { MessageSquare } from "lucide-react";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { CHAT_BUBBLE_TOOLBAR_BUTTON_CLASS } from "@src/components/ChatBubble";

import type { CloudSessionComment } from "../org2CloudCommentsClient";
import { countLiveComments } from "../org2CloudSessionCommentsAtom";
import CommentThreadList from "./CommentThreadList";
import { useSessionCommentsContext } from "./SessionCommentsContext";

export interface TurnCommentChromeProps {
  /** Turn anchor: the group's leading user-message event id. */
  anchorEventId: string;
  /** Render the message card with the optional comment toolbar action. */
  renderMessage: (toolbarAction: React.ReactNode) => React.ReactNode;
}

const TurnCommentChrome: React.FC<TurnCommentChromeProps> = ({
  anchorEventId,
  renderMessage,
}) => {
  const { t } = useTranslation("navigation");
  const context = useSessionCommentsContext();
  const [open, setOpen] = useState(false);

  const addComment = context?.addComment;
  const toSourceEventId = context?.toSourceEventId;
  const handleAdd = useCallback(
    async (
      body: string,
      parentId?: string,
      mentionedUserIds?: string[]
    ): Promise<CloudSessionComment | undefined> => {
      if (!addComment) return undefined;
      // Replies inherit the parent's anchor — never send both (0014
      // contradictory-anchor rule). The created row flows back so the list
      // can run its `@agent ` / post-submit agent affordances. Anchors ride
      // the SOURCE plane, so a fork/import's namespaced local id is stripped.
      return addComment(
        parentId
          ? { body, parentId, mentionedUserIds }
          : {
              body,
              mentionedUserIds,
              eventId: toSourceEventId
                ? toSourceEventId(anchorEventId)
                : anchorEventId,
            }
      );
    },
    [addComment, toSourceEventId, anchorEventId]
  );

  // Hidden in group-chat view: the transcript there merges MEMBER-session
  // events whose ids can never anchor into this session's comment plane.
  if (!context || !context.turnAnchorsVisible) {
    return <>{renderMessage(null)}</>;
  }

  const sourceAnchorEventId = context.toSourceEventId(anchorEventId);
  const threads = context.grouped.byEventId.get(sourceAnchorEventId) ?? [];
  const liveCount = countLiveComments(threads);
  const toggleLabel = t("cloud.comments.toggleLabel");

  return (
    <>
      {renderMessage(
        <button
          type="button"
          className={`${CHAT_BUBBLE_TOOLBAR_BUTTON_CLASS} gap-1 leading-none text-primary-6`}
          aria-label={toggleLabel}
          title={toggleLabel}
          aria-expanded={open}
          data-testid={`session-comment-toggle-${anchorEventId}`}
          onClick={(event) => {
            event.stopPropagation();
            setOpen((current) => !current);
          }}
        >
          <MessageSquare size={14} strokeWidth={2} />
          {liveCount > 0 && (
            <span className="text-[11px] leading-none">{liveCount}</span>
          )}
        </button>
      )}
      {open && (
        <div
          className="mt-1 rounded-lg border border-border-2 bg-bg-2 p-2"
          data-testid="session-comment-thread"
        >
          <CommentThreadList
            threads={threads}
            viewerUserId={context.viewerUserId}
            viewerIsAdmin={context.viewerIsAdmin}
            composerDisabled={!context.canAnchorTurns}
            composerDisabledReason={
              context.canAnchorTurns
                ? undefined
                : t("cloud.comments.replayRequired")
            }
            onComposerCancel={() => setOpen(false)}
            emptyLabel={
              context.state === "error"
                ? t("cloud.comments.loadError")
                : t("cloud.comments.empty")
            }
            onAdd={handleAdd}
            onEdit={context.editComment}
            onDelete={context.deleteComment}
            onResolve={context.resolveComment}
          />
        </div>
      )}
    </>
  );
};

export default TurnCommentChrome;
