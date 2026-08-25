/**
 * DiscussionChannelPanelView — the chat-pane surface behind a `"channel"` tab.
 *
 * One surface, two scopes:
 *
 *  - **local** channels have a WORKING message plane. Posts land in
 *    `localChannelMessagesAtom` (this machine, single user) and survive a
 *    restart; edit and tombstone-delete are available on every row.
 *
 *  - **cloud** channels render the identical header + transcript + composer
 *    against the message RPCs (`useCloudChannelMessages`), multi-author and
 *    realtime-reconciled. A backend WITHOUT the `orgChannelMessages`
 *    capability keeps the original honest gate: the same composer renders
 *    inert with the explanation above it, because there is no RPC to call.
 *
 * Both scopes are built from session parts, not look-alikes: the transcript is
 * `ChannelMessageList` on `DETAIL_PANEL_TOKENS.contentMaxWidth`, and the
 * composer is the real `InputArea` in the absolutely positioned footer
 * `HumanSessionView` uses. Settings reuses the existing per-scope dialog —
 * this view mounts it, never reimplements it. Cloud rows go through the SAME
 * `ChannelMessageList` / `ChannelMessageRow` as local ones, so session cards
 * and ordinary reference links render identically on both planes.
 *
 * A channel with a WRITABLE message plane is also a session DROP target
 * (`useChannelSessionDrop`): dragging a session row or tab anywhere over the
 * panel attaches it to the draft as a reference pill. A gated or archived
 * channel mounts no drop target — a reference dropped on a channel that
 * cannot post is a promise the surface can't keep. Archived is read-only on
 * BOTH scopes: the cloud RPC refuses the write anyway (`ORG2_CHANNEL_ARCHIVED`),
 * so the composer and the row actions match the local plane exactly.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { MessagesSquare } from "lucide-react";
import React, { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import type { ComposerInputRef } from "@src/components/ComposerInput";
import { INPUT_AREA } from "@src/config/inputAreaTokens";
import LocalChannelSettingsDialog from "@src/features/LocalChannels/components/LocalChannelSettingsDialog";
import ChannelSettingsDialog from "@src/features/Org2Cloud/channels/components/ChannelSettingsDialog";
import {
  isOptimisticChannelMessageId,
  useCloudChannelMessages,
} from "@src/features/Org2Cloud/channels/useCloudChannelMessages";
import { useOrgChannels } from "@src/features/Org2Cloud/channels/useOrgChannels";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { SESSION_TAB_DROP_TARGET_HIGHLIGHT_CLASS } from "@src/shared/dnd/sessionTabDrag";
import type { ChatPanelSelectedChannel } from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  deleteLocalChannelMessageAtom,
  editLocalChannelMessageAtom,
  localChannelMessagesForChannelAtomFamily,
  postLocalChannelMessageAtom,
} from "@src/store/ui/localChannelMessagesAtom";
import { localChannelsAtom } from "@src/store/ui/localChannelsAtom";

import ChannelComposer from "./ChannelComposer";
import ChannelMessageList from "./ChannelMessageList";
import ChannelPanelHeader from "./ChannelPanelHeader";
import type { ChannelFeedMessage } from "./channelFeedRows";
import {
  createChannelPostHandler,
  createCloudChannelPostHandler,
  resolveCloudChannelErrorKey,
} from "./channelPostHandler";
import { useChannelSessionDrop } from "./useChannelSessionDrop";

/**
 * Bottom inset on the empty-state column so the placeholder clears the
 * absolutely positioned composer footer (matches the transcript's `pb-36`).
 */
const EMPTY_STATE_COLUMN_CLASSES =
  "flex min-h-0 flex-1 items-center justify-center pb-36";

const COMPOSER_NOTICE_CLASSES = `border border-dashed border-border-2 bg-fill-1 px-3 py-2.5 text-[12px] text-text-3 ${INPUT_AREA.borderRadiusClass}`;

export interface DiscussionChannelPanelViewProps {
  channel: ChatPanelSelectedChannel;
}

// ---------------------------------------------------------------------------
// Local scope — the working message plane
// ---------------------------------------------------------------------------

interface LocalChannelPanelProps {
  channelId: string;
  fallbackName: string;
}

const LocalChannelPanel: React.FC<LocalChannelPanelProps> = ({
  channelId,
  fallbackName,
}) => {
  const { t } = useTranslation("navigation");
  const channels = useAtomValue(localChannelsAtom);
  const messages = useAtomValue(
    localChannelMessagesForChannelAtomFamily(channelId)
  );
  const postMessage = useSetAtom(postLocalChannelMessageAtom);
  const editMessage = useSetAtom(editLocalChannelMessageAtom);
  const deleteMessage = useSetAtom(deleteLocalChannelMessageAtom);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const composerFooterRef = useRef<HTMLElement | null>(null);
  const composerInputRef = useRef<ComposerInputRef | null>(null);

  // Read the live row so a rename made in the settings dialog shows up here
  // without re-opening the tab; the tab payload is only the fallback.
  const channel = useMemo(
    () => channels.find((candidate) => candidate.id === channelId) ?? null,
    [channelId, channels]
  );
  // Archived = read-only (Slack/cloud expectation): a post the store accepts
  // but the cloud plane would refuse on promotion is a semantic cliff.
  const archived = channel !== null && channel.archivedAt !== null;

  // Transcript + composer are ONE drop target: a session dragged from the
  // sidebar or a tab strip anywhere over this panel becomes a pill in the
  // draft, the same reference an `@` mention would produce.
  const sessionDrop = useChannelSessionDrop({
    surfaceRef,
    composerFooterRef,
    composerInputRef,
    disabled: archived,
  });

  // `InputArea` reads its submit handler through `onSubmitOverride`; the
  // refusal path throws so the composer restores the draft (see
  // `channelPostHandler.ts`).
  const handlePost = useMemo(
    () =>
      createChannelPostHandler({
        post: (body) => postMessage({ channelId, body }),
        translate: (key) => t(key),
        onError: setComposerError,
      }),
    [channelId, postMessage, t]
  );

  const handleEdit = useCallback(
    (messageId: string, body: string): boolean =>
      editMessage({ id: messageId, body }).ok,
    [editMessage]
  );

  const handleDelete = useCallback(
    (messageId: string) => {
      deleteMessage(messageId);
    },
    [deleteMessage]
  );

  // A channel deleted while its tab is open leaves the pill pointing at
  // nothing; say so instead of rendering an empty transcript.
  if (!channel) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <Placeholder
          variant="empty"
          placement="detail-panel"
          fillParentHeight
          icon={<MessagesSquare size={32} strokeWidth={1.5} />}
          title={t("cloud.channels.feed.missingTitle")}
          subtitle={t("cloud.channels.feed.missingSubtitle")}
        />
      </div>
    );
  }

  const displayName = channel.name || fallbackName;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="channel-panel">
      <ChannelPanelHeader
        name={displayName}
        topic={channel.topic}
        isPrivate={false}
        memberCount={undefined}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        ref={surfaceRef}
        data-testid="channel-session-drop-surface"
      >
        {sessionDrop.active ? (
          <div
            className={`${SESSION_TAB_DROP_TARGET_HIGHLIGHT_CLASS} inset-2 flex items-end justify-center pb-40`}
            data-testid="channel-session-drop-zone"
            data-drop-over={String(sessionDrop.over)}
            role="status"
            aria-live="polite"
          >
            <span className="rounded-md border border-border-2 bg-bg-2 px-3 py-1.5 text-xs font-medium text-text-1 shadow-sm">
              {t("cloud.channels.feed.dropSessionHint")}
            </span>
          </div>
        ) : null}
        {messages.length === 0 ? (
          <div className={EMPTY_STATE_COLUMN_CLASSES}>
            <Placeholder
              variant="empty"
              placement="detail-panel"
              icon={<MessagesSquare size={32} strokeWidth={1.5} />}
              title={t("cloud.channels.feed.emptyTitle", {
                name: displayName,
              })}
              subtitle={t("cloud.channels.feed.emptySubtitle")}
            />
          </div>
        ) : (
          <ChannelMessageList
            messages={messages}
            authorLabel={t("cloud.channels.feed.you")}
            onEdit={archived ? null : handleEdit}
            onDelete={archived ? null : handleDelete}
          />
        )}
        <ChannelComposer
          composerId={`channel-local-${channelId}`}
          placeholder={t("cloud.channels.feed.composerPlaceholder", {
            name: displayName,
          })}
          onSubmit={archived ? null : handlePost}
          acceptDraggedPills={!archived}
          error={archived ? null : composerError}
          notice={
            archived ? (
              <div
                className={COMPOSER_NOTICE_CLASSES}
                data-testid="channel-composer-archived"
              >
                {t("cloud.channels.feed.archivedComposerDisabled")}
              </div>
            ) : undefined
          }
          footerRef={composerFooterRef}
          composerInputRef={composerInputRef}
        />
      </div>
      <LocalChannelSettingsDialog
        key={settingsOpen ? `settings-open-${channel.id}` : "settings"}
        open={settingsOpen}
        channel={settingsOpen ? channel : null}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Cloud scope — same surface, composer gated on the backend upgrade
// ---------------------------------------------------------------------------

interface CloudChannelPanelProps {
  orgId: string;
  channelId: string;
  fallbackName: string;
  fallbackIsPrivate: boolean;
}

const CloudChannelPanel: React.FC<CloudChannelPanelProps> = ({
  orgId,
  channelId,
  fallbackName,
  fallbackIsPrivate,
}) => {
  const { t } = useTranslation("navigation");
  // Archived channels stay browsable (Slack): without includeArchived an
  // open tab for an archived channel would lose its live row — stale header
  // name and no settings — even though the sidebar lets archived rows open.
  // The hook PARTITIONS archived rows into `archivedChannels`; resolving
  // against the live list alone re-creates exactly that stale-header hole.
  const { channels, archivedChannels } = useOrgChannels(orgId, {
    includeArchived: true,
  });
  const {
    phase,
    messages,
    hasOlder,
    loadingOlder,
    loadOlder,
    postMessage,
    editMessage,
    deleteMessage,
    currentUserId,
  } = useCloudChannelMessages(orgId, channelId);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const composerFooterRef = useRef<HTMLElement | null>(null);
  const composerInputRef = useRef<ComposerInputRef | null>(null);

  const channel = useMemo(
    () =>
      channels.find((candidate) => candidate.id === channelId) ??
      archivedChannels.find((candidate) => candidate.id === channelId) ??
      null,
    [archivedChannels, channelId, channels]
  );
  const archived = channel?.archivedAt != null;

  // Older backends answer the capability probe with `orgChannelMessages`
  // absent: no RPC to call, so the surface keeps its original honest gate.
  const gated = phase === "unsupported";
  // Archived = read-only on BOTH scopes, matching the local plane: the RPC
  // refuses the write with ORG2_CHANNEL_ARCHIVED regardless, so offering an
  // enabled composer (or row edit/delete) here would only produce a refusal.
  const canPost = phase === "ready" && !archived;

  const sessionDrop = useChannelSessionDrop({
    surfaceRef,
    composerFooterRef,
    composerInputRef,
    disabled: !canPost,
  });

  const youLabel = t("cloud.channels.feed.you");
  const unknownAuthorLabel = t("cloud.channels.feed.unknownAuthor");

  // The cloud rows adapted to the transcript's scope-neutral shape — the same
  // renderer the local plane uses, so link/card projection stays identical.
  const feedMessages = useMemo<ChannelFeedMessage[]>(
    () =>
      messages.map((message) => {
        const mine = message.authorUserId === currentUserId;
        return {
          id: message.id,
          channelId: message.channelId,
          body: message.body,
          createdAt: message.createdAt,
          editedAt: message.editedAt,
          deletedAt: message.deletedAt,
          authorUserId: message.authorUserId,
          authorLabel: mine
            ? youLabel
            : (message.authorDisplayName ?? unknownAuthorLabel),
          authorAvatarUrl: message.authorAvatarUrl,
          // Optimistic rows have no server id yet; offering edit/delete on
          // them guarantees ORG2_MESSAGE_NOT_FOUND.
          canModify: mine && !isOptimisticChannelMessageId(message.id),
        };
      }),
    [currentUserId, messages, unknownAuthorLabel, youLabel]
  );

  const handlePost = useMemo(
    () =>
      createCloudChannelPostHandler({
        post: postMessage,
        translate: (key) => t(key),
        onError: setComposerError,
      }),
    [postMessage, t]
  );

  const handleEdit = useCallback(
    async (messageId: string, body: string): Promise<boolean> => {
      // The local plane refuses empty edits client-side; mirror it instead
      // of surfacing the server's generic ORG2_VALIDATION copy.
      if (body.trim().length === 0) return false;
      try {
        await editMessage(messageId, body);
        setComposerError(null);
        return true;
      } catch (error) {
        // Keep the inline editor open and say why the save was refused.
        setComposerError(t(resolveCloudChannelErrorKey(error)));
        return false;
      }
    },
    [editMessage, t]
  );

  const handleDelete = useCallback(
    (messageId: string) => {
      void (async () => {
        try {
          await deleteMessage(messageId);
          setComposerError(null);
        } catch (error) {
          setComposerError(t(resolveCloudChannelErrorKey(error)));
        }
      })();
    },
    [deleteMessage, t]
  );

  const displayName = channel?.name ?? fallbackName;

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="channel-panel">
      <ChannelPanelHeader
        name={displayName}
        topic={channel?.topic}
        isPrivate={
          channel ? channel.visibility === "private" : fallbackIsPrivate
        }
        memberCount={channel?.memberCount}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        ref={surfaceRef}
        data-testid={
          canPost ? "channel-session-drop-surface" : "channel-cloud-surface"
        }
      >
        {sessionDrop.active ? (
          <div
            className={`${SESSION_TAB_DROP_TARGET_HIGHLIGHT_CLASS} inset-2 flex items-end justify-center pb-40`}
            data-testid="channel-session-drop-zone"
            data-drop-over={String(sessionDrop.over)}
            role="status"
            aria-live="polite"
          >
            <span className="rounded-md border border-border-2 bg-bg-2 px-3 py-1.5 text-xs font-medium text-text-1 shadow-sm">
              {t("cloud.channels.feed.dropSessionHint")}
            </span>
          </div>
        ) : null}
        {feedMessages.length === 0 ? (
          <div className={EMPTY_STATE_COLUMN_CLASSES}>
            {phase === "loading" || phase === "signedOut" ? (
              <Placeholder variant="loading" placement="detail-panel" />
            ) : (
              <Placeholder
                variant="empty"
                placement="detail-panel"
                icon={<MessagesSquare size={32} strokeWidth={1.5} />}
                title={
                  gated
                    ? t("cloud.channels.feed.cloudPendingTitle")
                    : phase === "ready"
                      ? t("cloud.channels.feed.emptyTitle", {
                          name: displayName,
                        })
                      : t("cloud.channels.feed.loadError")
                }
                subtitle={
                  gated
                    ? t("cloud.channels.feed.cloudPendingSubtitle")
                    : phase === "ready"
                      ? t("cloud.channels.feed.emptySubtitle")
                      : undefined
                }
              />
            )}
          </div>
        ) : (
          <ChannelMessageList
            messages={feedMessages}
            authorLabel={youLabel}
            cloudOrgId={orgId}
            onEdit={canPost ? handleEdit : null}
            onDelete={canPost ? handleDelete : null}
            header={
              hasOlder ? (
                <div className="flex justify-center pb-2">
                  <Button
                    htmlType="button"
                    variant="tertiary"
                    size="mini"
                    loading={loadingOlder}
                    data-testid="channel-load-older"
                    onClick={loadOlder}
                  >
                    {t("cloud.channels.feed.loadOlder")}
                  </Button>
                </div>
              ) : null
            }
          />
        )}
        {/* One composer, two states. With the capability the real post handler
            is wired; without it the SAME composer renders inert with the
            explanation above it, instead of accepting text it could never
            send — and `acceptDraggedPills` goes off for the same reason. */}
        <ChannelComposer
          composerId={`channel-cloud-${orgId}-${channelId}`}
          placeholder={t("cloud.channels.feed.composerPlaceholder", {
            name: displayName,
          })}
          onSubmit={canPost ? handlePost : null}
          acceptDraggedPills={canPost}
          error={archived ? null : composerError}
          footerRef={composerFooterRef}
          composerInputRef={composerInputRef}
          notice={
            /* Archived outranks the capability gate: it is the reason the
               user actually cannot post here, and it holds on a backend that
               does have the message plane. */
            archived ? (
              <div
                className={COMPOSER_NOTICE_CLASSES}
                data-testid="channel-composer-archived"
              >
                {t("cloud.channels.feed.archivedComposerDisabled")}
              </div>
            ) : gated ? (
              <div
                className={COMPOSER_NOTICE_CLASSES}
                data-testid="channel-composer-disabled"
              >
                {t("cloud.channels.feed.cloudComposerDisabled")}
              </div>
            ) : undefined
          }
        />
      </div>
      <ChannelSettingsDialog
        key={settingsOpen ? `settings-open-${channelId}` : "settings"}
        open={settingsOpen && channel !== null}
        orgId={orgId}
        channel={settingsOpen ? channel : null}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
};

const DiscussionChannelPanelView: React.FC<DiscussionChannelPanelViewProps> = ({
  channel,
}) =>
  channel.scope === "local" ? (
    <LocalChannelPanel
      channelId={channel.channelId}
      fallbackName={channel.name}
    />
  ) : (
    <CloudChannelPanel
      orgId={channel.orgId}
      channelId={channel.channelId}
      fallbackName={channel.name}
      fallbackIsPrivate={channel.visibility === "private"}
    />
  );

export default DiscussionChannelPanelView;
