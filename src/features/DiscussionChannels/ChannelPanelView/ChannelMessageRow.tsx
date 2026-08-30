/**
 * One transcript row — either a date divider or a message.
 *
 * Message bodies render through `MarkDown` (the same component the session
 * transcript uses) at the transcript's own body typography (`text-sm
 * leading-6 text-text-1`) so a channel post reads like agent/user output. A
 * tombstoned row renders the italic "message deleted" line instead, matching
 * how `CommentThreadList` keeps a deleted comment's slot in the thread.
 *
 * A body is split first (`splitChannelMessageBody`), because its parts want
 * different treatment on the READ side:
 *
 *  - session references are promoted out of prose and rendered as cards;
 *  - every other composer reference is projected to an ordinary Markdown
 *    link, so posted text never reuses the composer's blue pill treatment.
 *
 * Horizontal inset is `CHAT_ITEM_PADDING_X` — the same token `ChatItemWrap`
 * applies to every session transcript item — so rows sit on the transcript's
 * gutter inside the shared max-width column, not on a bespoke one.
 *
 * Edit is inline (`Textarea` + Save / Cancel), the shape the comment plane
 * already uses — no dialog, no separate route.
 */
import { useSetAtom, useStore } from "jotai";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import MarkDown from "@src/components/MarkDown";
import PersonAvatar from "@src/components/PersonAvatar";
import { LocalSessionReferenceCard } from "@src/components/SessionReferenceCard";
import Textarea from "@src/components/Textarea";
import Tooltip from "@src/components/Tooltip";
import { CHAT_ITEM_PADDING_X } from "@src/engines/ChatPanel/blocks/primitives/config";
import {
  Cancel01Icon,
  Delete02Icon,
  HugeiconsIcon,
  Pen01Icon,
  Tick01Icon,
} from "@src/icons";
import { openOrFocusSessionInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabOpenAtoms";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import { LOCAL_CHANNEL_MESSAGE_MAX_LENGTH } from "@src/store/ui/localChannelMessagesAtom";
import { formatLocalClock } from "@src/util/data/formatters/date";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import ChannelCloudSessionCard, {
  ChannelSessionReferenceCard,
} from "./ChannelCloudSessionCard";
import type {
  ChannelDateDividerLabel,
  ChannelFeedMessage,
} from "./channelFeedRows";
import {
  type ChannelMessageReference,
  channelReferenceKey,
  splitChannelMessageBody,
} from "./channelMessageBody";

export interface ChannelDateDividerProps {
  label: ChannelDateDividerLabel;
}

export const ChannelDateDivider: React.FC<ChannelDateDividerProps> = ({
  label,
}) => {
  const { t } = useTranslation("navigation");
  const text =
    label.kind === "today"
      ? t("cloud.channels.feed.today")
      : label.kind === "yesterday"
        ? t("cloud.channels.feed.yesterday")
        : label.date.toLocaleDateString(undefined, {
            weekday: "short",
            month: "short",
            day: "numeric",
            year:
              label.date.getFullYear() === new Date().getFullYear()
                ? undefined
                : "numeric",
          });

  return (
    <div
      className={`flex items-center gap-3 py-3 ${CHAT_ITEM_PADDING_X}`}
      data-testid="channel-date-divider"
    >
      <div className="h-px flex-1 bg-border-2" />
      <span className="shrink-0 text-[11px] font-medium text-text-3">
        {text}
      </span>
      <div className="h-px flex-1 bg-border-2" />
    </div>
  );
};

/** One promoted session attachment, resolved from its owning local/cloud store. */
const ReferenceCard: React.FC<{
  reference: ChannelMessageReference;
  onOpenSession: (sessionId: string, fallbackTitle?: string) => void;
  cloudOrgId?: string;
}> = ({ reference, onOpenSession, cloudOrgId }) => {
  if (reference.kind === "session") {
    return cloudOrgId ? (
      <ChannelSessionReferenceCard
        sessionId={reference.sessionId}
        fallbackTitle={reference.title}
        cloudOrgId={cloudOrgId}
        onOpenLocal={onOpenSession}
      />
    ) : (
      <LocalSessionReferenceCard
        sessionId={reference.sessionId}
        fallbackTitle={reference.title}
        onOpen={onOpenSession}
        testId="channel-session-card"
      />
    );
  }
  if (reference.kind === "cloudSession") {
    return (
      <ChannelCloudSessionCard
        reference={reference.reference}
        fallbackTitle={reference.title}
      />
    );
  }
  return null;
};

export interface ChannelMessageRowProps {
  message: ChannelFeedMessage;
  /** Continues the block above: avatar + author line are suppressed. */
  grouped: boolean;
  /** Fallback author label when the row carries none (already localized). */
  authorLabel: string;
  /** Enables safe recovery of legacy source-only pills in a cloud channel. */
  cloudOrgId?: string;
  /**
   * Null when the surface has no writable message plane (a backend without
   * the message capability). Cloud edits are async, so the handler may hand
   * back a promise — the editor stays open until it resolves true.
   */
  onEdit:
    | ((messageId: string, body: string) => boolean | Promise<boolean>)
    | null;
  onDelete: ((messageId: string) => void) | null;
}

const ChannelMessageRow: React.FC<ChannelMessageRowProps> = ({
  message,
  grouped,
  authorLabel,
  cloudOrgId,
  onEdit,
  onDelete,
}) => {
  const { t } = useTranslation("navigation");
  const store = useStore();
  const openSession = useSetAtom(openOrFocusSessionInChatPanelTabAtom);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.body);
  const isTombstone = message.deletedAt !== null;
  // Multi-author planes gate the row actions to the author's own rows; the
  // single-user local plane leaves `canModify` unset and keeps both.
  const isMine = message.canModify ?? true;
  const canEdit = onEdit !== null && !isTombstone && isMine;
  const canDelete = onDelete !== null && !isTombstone && isMine;
  const displayAuthor = message.authorLabel ?? authorLabel;

  // Editing stays on the RAW body — the stored pill syntax is what the author
  // typed, and rewriting it from the split would drop their references.
  const { text: bodyText, references } = useMemo(
    () => splitChannelMessageBody(message.body),
    [message.body]
  );

  const handleOpenSession = useCallback(
    (sessionId: string, fallbackTitle?: string) => {
      const session = store.get(sessionByIdAtom(sessionId));
      openSession({
        sessionId,
        sessionName: session?.name ?? fallbackTitle,
        repoPath: session?.repoPath,
      });
    },
    [openSession, store]
  );

  const startEditing = useCallback(() => {
    setDraft(message.body);
    setEditing(true);
  }, [message.body]);

  const saveEdit = useCallback(() => {
    if (!onEdit) return;
    void (async () => {
      // Keep the editor open on refusal so the text is never thrown away.
      if (await onEdit(message.id, draft)) setEditing(false);
    })();
  }, [draft, message.id, onEdit]);

  const messageActions =
    canEdit || canDelete ? (
      <span
        className={`${grouped ? "absolute right-0 top-0 z-10 rounded-md bg-bg-1" : "ml-auto"} inline-flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/channelmsg:opacity-100 group-hover/channelmsg:opacity-100`}
      >
        {canEdit ? (
          <Tooltip content={t("cloud.channels.feed.edit")} framedPanel>
            <Button
              htmlType="button"
              variant="tertiary"
              size="mini"
              iconOnly
              aria-label={t("cloud.channels.feed.edit")}
              data-testid="channel-message-edit"
              icon={
                <HugeiconsIcon
                  icon={Pen01Icon}
                  data-icon="pencil"
                  size={12}
                  strokeWidth={2}
                />
              }
              onClick={startEditing}
            />
          </Tooltip>
        ) : null}
        {canDelete ? (
          <Tooltip content={t("cloud.channels.feed.delete")} framedPanel>
            <Button
              htmlType="button"
              variant="tertiary"
              size="mini"
              iconOnly
              aria-label={t("cloud.channels.feed.delete")}
              data-testid="channel-message-delete"
              icon={
                <HugeiconsIcon
                  icon={Delete02Icon}
                  data-icon="trash-2"
                  size={12}
                  strokeWidth={2}
                />
              }
              onClick={() => onDelete?.(message.id)}
            />
          </Tooltip>
        ) : null}
      </span>
    ) : null;

  return (
    <div
      className={`group/channelmsg allow-select-deep flex gap-2 ${CHAT_ITEM_PADDING_X} ${grouped ? "py-0.5" : "pb-1 pt-2"}`}
      data-testid="channel-message"
      data-message-id={message.id}
    >
      <div className="w-7 shrink-0">
        {grouped ? null : (
          <PersonAvatar
            size={28}
            name={displayAuthor}
            src={message.authorAvatarUrl}
          />
        )}
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col gap-0.5">
        {grouped ? messageActions : null}
        {grouped ? null : (
          <div className="flex min-w-0 items-baseline gap-2">
            <span
              className="truncate text-[13px] font-semibold text-text-1"
              data-testid="channel-message-author"
            >
              {displayAuthor}
            </span>
            <Tooltip
              content={formatRelativeTime(message.createdAt, "long")}
              framedPanel
            >
              <span className="shrink-0 text-[11px] text-text-3">
                {formatLocalClock(new Date(message.createdAt), undefined)}
              </span>
            </Tooltip>
            {message.editedAt !== null && !isTombstone ? (
              <span
                className="shrink-0 text-[11px] text-text-4"
                data-testid="channel-message-edited"
              >
                {t("cloud.channels.feed.edited")}
              </span>
            ) : null}
            {messageActions}
          </div>
        )}

        {isTombstone ? (
          <div
            className="text-[12px] italic text-text-3"
            data-testid="channel-message-tombstone"
          >
            {t("cloud.channels.feed.deletedMessage")}
          </div>
        ) : editing ? (
          <div className="flex flex-col gap-1.5">
            <Textarea
              value={draft}
              onChange={(value) => setDraft(value)}
              // The comment-plane editing shortcuts: Ctrl/Cmd+Enter saves,
              // Escape leaves the autofocused editor without a mouse.
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  saveEdit();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setEditing(false);
                }
              }}
              size="small"
              autoSize
              rows={2}
              // Both planes bound bodies at 4000 (the cloud RPC enforces the
              // same ceiling), so one constant covers the shared editor.
              maxLength={LOCAL_CHANNEL_MESSAGE_MAX_LENGTH}
              autoFocus
              data-testid="channel-message-edit-input"
            />
            <div className="flex items-center justify-end gap-1.5">
              <Button
                htmlType="button"
                variant="tertiary"
                size="mini"
                icon={
                  <HugeiconsIcon
                    icon={Cancel01Icon}
                    data-icon="x"
                    size={12}
                    strokeWidth={2}
                  />
                }
                data-testid="channel-message-edit-cancel"
                onClick={() => setEditing(false)}
              >
                {t("cloud.channels.cancel")}
              </Button>
              <Button
                htmlType="button"
                variant="primary"
                size="mini"
                disabled={draft.trim().length === 0}
                icon={
                  <HugeiconsIcon
                    icon={Tick01Icon}
                    data-icon="check"
                    size={12}
                    strokeWidth={2}
                  />
                }
                data-testid="channel-message-edit-save"
                onClick={saveEdit}
              >
                {t("cloud.channels.feed.save")}
              </Button>
            </div>
          </div>
        ) : (
          <div
            className="min-w-0 break-words text-sm leading-6 text-text-1"
            data-testid="channel-message-body"
          >
            {bodyText ? (
              <MarkDown textContent={bodyText} skipPreprocess />
            ) : null}
            {references.map((reference) => (
              <ReferenceCard
                key={channelReferenceKey(reference)}
                reference={reference}
                onOpenSession={handleOpenSession}
                cloudOrgId={cloudOrgId}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default ChannelMessageRow;
