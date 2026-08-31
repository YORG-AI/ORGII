import { useAtomValue } from "jotai";
import React, {
  type FC,
  type MouseEvent,
  type SyntheticEvent,
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  CHAT_BUBBLE_TOOLBAR_BUTTON_CLASS,
  ChatBubbleCopyButton,
} from "@src/components/ChatBubble";
import ClampedContent from "@src/components/ClampedContent";
import ExpandOverlay from "@src/components/ExpandOverlay";
import PersonAvatar from "@src/components/PersonAvatar";
import { REPO_SETUP_PROMPT_MARKER } from "@src/config/repoSetupMarker";
import type { OptimizedChatItem } from "@src/engines/ChatPanel/ChatHistory/chatItemPipeline/types";
import { useSessionCommentsContext } from "@src/features/Org2Cloud/SessionComments/SessionCommentsContext";
import type { ConversationSenderStamp } from "@src/features/Org2Cloud/SessionConversation/continuationEvents";
import { CONVERSATION_SENDER_ARG } from "@src/features/Org2Cloud/SessionConversation/continuationEvents";
import { discussionPayloadOf } from "@src/features/Org2Cloud/SessionConversation/discussionEvents";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  ClipboardCheckIcon,
  File01Icon,
  HugeiconsIcon,
  Image01Icon,
  PencilEdit01Icon,
  SparklesIcon,
  Undo02Icon,
} from "@src/icons";
import {
  formatSmartDateTime,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";
import { imageRefToRustPath } from "@src/util/file/imageRefs";

import UserMessageContent, {
  type UserMessageMention,
} from "../ChatHistory/components/UserMessageContent";
import InputArea from "../InputArea";
import { stripExpandedPillContent } from "../InputArea/utils/pillContentParser";
import SessionIdentityIcon from "../components/SessionIdentityIcon";
import { useParentAgentSender } from "./ParentAgentSenderContext";
import RawPromptToggle from "./RawPromptToggle";
import { useSharedConversationSender } from "./SharedConversationSenderContext";
import { normalizeUserMessageText } from "./normalizeUserMessageText";
import { wasSubmittedByViewer } from "./parentAgentSender";
import { resolveRawUserPrompt } from "./rawUserPrompt";
import { resolveUserMessageSide } from "./userMessageSide";

function readConversationSenderStamp(
  event: { args?: Record<string, unknown> } | undefined
): ConversationSenderStamp | null {
  const raw = event?.args?.[CONVERSATION_SENDER_ARG];
  if (!raw || typeof raw !== "object") return null;
  const stamp = raw as Partial<ConversationSenderStamp>;
  return typeof stamp.userId === "string" &&
    typeof stamp.displayName === "string"
    ? (stamp as ConversationSenderStamp)
    : null;
}

const USER_MSG_MAX_LINES = 3;
const USER_MSG_MAX_CHARS = 120;
// Continuous chat leaves roughly ten rendered lines visible before folding.
const USER_MSG_CONTINUOUS_PREVIEW_HEIGHT = 10 * 24;
const AGENT_ORG_INBOX_TRANSCRIPT_PREFIX = "Acknowledged inbox batch";
const PLAN_APPROVED_PREFIX = "[Plan approved";

// ============================================
// Types
// ============================================

interface UserChatItemProps {
  chatItem: OptimizedChatItem;
  /** Keep the short preview used by paginated/pinned turn headers. */
  compactPreview?: boolean;
  onEditSubmit?: (newText: string, imageDataUrls?: string[]) => void;
  /** Extra actions rendered in the message's copy / restore / edit toolbar. */
  toolbarActions?: React.ReactNode;
  /**
   * Restore the session to this message's checkpoint WITHOUT re-sending it
   * (Cursor-style restore). When provided, a restore button is shown next to
   * the edit button.
   */
  onRestoreCheckpoint?: () => void;
}

// ============================================
// Sub-components
// ============================================

const CachedFileChip: FC<{
  file: string;
  isPreviewOpen: boolean;
  onTogglePreview: (e: MouseEvent) => void;
  onClosePreview: (e: MouseEvent) => void;
}> = memo(({ file, isPreviewOpen, onTogglePreview, onClosePreview }) => {
  const isImg = /\.(png|jpg|jpeg|gif|webp)$/i.test(file);
  const fileName = file.split("/").pop();

  return (
    <div className="relative flex flex-col items-center">
      <div
        className="chat-block-content flex cursor-pointer items-center gap-1.5 rounded-md bg-fill-2 px-2.5 py-1 transition-colors hover:bg-fill-3"
        onClick={onTogglePreview}
      >
        {isImg ? (
          <HugeiconsIcon
            icon={Image01Icon}
            data-icon="image"
            size={13}
            strokeWidth={1.75}
            className="text-text-2"
          />
        ) : (
          <HugeiconsIcon
            icon={File01Icon}
            data-icon="file"
            size={13}
            strokeWidth={1.75}
            className="text-text-2"
          />
        )}
        <span className="text-text-2">{fileName}</span>
      </div>

      {isPreviewOpen && (
        <div
          className="absolute bottom-full left-1/2 z-50 mb-2 flex -translate-x-1/2 flex-col items-center rounded-xl bg-[#232325] p-3"
          style={{ minWidth: 180, maxWidth: 320 }}
        >
          <button
            className="absolute right-2 top-2 text-lg text-white/70 hover:text-white"
            onClick={onClosePreview}
          >
            ×
          </button>
          {isImg ? (
            <img
              src={file}
              alt="preview"
              className="rounded-lg object-contain"
              style={{ maxWidth: 200, maxHeight: 200 }}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center">
              <HugeiconsIcon
                icon={File01Icon}
                data-icon="file"
                size={32}
                strokeWidth={1.75}
                color="#888"
              />
              <div className="mt-2 text-white">{fileName}</div>
              <a
                href={file}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 text-blue-400 underline"
              >
                Open/Download
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
});
CachedFileChip.displayName = "CachedFileChip";

// ============================================
// Styles
// ============================================

/**
 * Layout-only; border/hover/focus ring added per-row below.
 *
 * The wrapping message row uses a NAMED group (`group/msg`) so the timestamp
 * toolbar reveals only for its own message. An unnamed `group` would also
 * match bare-group ancestors (e.g. the WorkStation AppShell), revealing every
 * message toolbar whenever the mouse was anywhere in the pane.
 */
const DISPLAY_CONTAINER_BASE =
  "relative w-fit max-w-[min(600px,100%)] rounded-2xl bg-fill-2 px-3 py-2";

// ============================================
// Component
// ============================================

const UserChatItem = ({
  chatItem,
  compactPreview = true,
  onEditSubmit,
  toolbarActions,
  onRestoreCheckpoint,
}: UserChatItemProps) => {
  const { t, i18n } = useTranslation("sessions");
  const sharedConversationSender = useSharedConversationSender();
  const viewerCloudUserId = useAtomValue(org2CloudAuthAtom)?.userId ?? null;
  const [isEditing, setIsEditing] = useState(false);

  const [isExpanded, setIsExpanded] = useState(false);
  const [isRawPromptOpen, setIsRawPromptOpen] = useState(false);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  // Editable copy of the message's attached images; seeded on edit entry so
  // the user can remove stale duplicates before resending.
  const [editImageList, setEditImageList] = useState<string[] | undefined>(
    undefined
  );
  const messageContentRef = useRef<HTMLDivElement | null>(null);

  const event = chatItem.event;
  // Who wrote this turn. In a session an agent started, a `user` turn is the
  // parent's dispatch rather than the reader's own message, so the row is
  // attributed to the parent session — same identity icon the header shows.
  // Resolved once for the whole chat; see ParentAgentSenderContext.
  const parentAgentSender = useParentAgentSender();
  // Team chat @-mentions: the comment carries account ids; names come from
  // the org roster so the `@name` text renders as a member pill.
  const comments = useSessionCommentsContext();
  const mentionableMembers = comments?.mentionableMembers;
  const mentionedUserIds = event
    ? discussionPayloadOf(event)?.mentionedUserIds
    : undefined;
  const mentions = useMemo((): UserMessageMention[] | undefined => {
    if (!mentionedUserIds?.length) return undefined;
    const resolved: UserMessageMention[] = [];
    for (const userId of mentionedUserIds) {
      const member = mentionableMembers?.find(
        (candidate) => candidate.userId === userId
      );
      const displayName = member?.displayName?.trim();
      if (displayName) resolved.push({ userId, displayName });
    }
    return resolved.length > 0 ? resolved : undefined;
  }, [mentionedUserIds, mentionableMembers]);
  const editedText = event?.displayText
    ? stripExpandedPillContent(String(event.displayText))
    : "";

  const activityResult = useMemo(() => {
    if (event) {
      return { result: event.result };
    }
    return undefined;
  }, [event]);

  const activityImages = useMemo((): string[] | undefined => {
    const result = activityResult?.result as
      | Record<string, unknown>
      | undefined;
    const images = result?.images;
    if (!Array.isArray(images) || images.length === 0) return undefined;
    return images.filter((image): image is string => typeof image === "string");
  }, [activityResult]);

  const fullContent = useMemo(() => {
    // When display_text is present on the event it is the pill-format string
    // that the user originally typed (e.g. "create-rule [skill:/create-rule]").
    // Prefer it unconditionally — falling back to message.content would show the
    // expanded YAML/raw text instead of the pill badge.
    if (editedText) return normalizeUserMessageText(editedText, activityImages);

    // Legacy path: no display_text stored (old messages). Use message.content
    // stripped of any auto-expanded pill block.
    const message = activityResult?.result?.message as
      | { content?: string }
      | undefined;
    const content = message?.content;
    if (typeof content === "string") {
      return normalizeUserMessageText(
        stripExpandedPillContent(content),
        activityImages
      );
    }
    return "";
  }, [activityImages, activityResult, editedText]);

  const isAgentOrgInboxTranscript = Boolean(
    event?.args?.agentOrgInboxTranscript === true ||
    (activityResult?.result as Record<string, unknown> | undefined)
      ?.agentOrgInboxTranscript === true ||
    fullContent.startsWith(AGENT_ORG_INBOX_TRANSCRIPT_PREFIX)
  );

  // Extract images from activity result for display in chat history.
  const messageImages = isAgentOrgInboxTranscript ? undefined : activityImages;

  const needsTruncation = useMemo(() => {
    if (!compactPreview) return false;
    const textToCheck = fullContent || editedText;
    if (!textToCheck) return false;
    if (textToCheck.split("\n").length > USER_MSG_MAX_LINES) return true;
    return textToCheck.length > USER_MSG_MAX_CHARS;
  }, [compactPreview, editedText, fullContent]);

  // The wire prompt behind this bubble. `fullContent` is a rendering of it
  // (pills as badges, expansion block stripped, envelope normalized), so the
  // raw string is only reachable through the event itself.
  const rawPrompt = useMemo(() => resolveRawUserPrompt(event), [event]);

  // Per-message timestamp shown beneath the bubble. Same smart-format used by
  // the other chat surfaces (Group chat, Org task, email): today → 24h time,
  // yesterday → "Yesterday HH:mm", older → "Jun 13, HH:mm".
  const timestampLabel = useMemo(() => {
    const createdAt = event?.createdAt;
    if (!createdAt) return "";
    return formatSmartDateTime(createdAt, {
      yesterdayLabel: t("common:relativeDate.yesterday", {
        defaultValue: "Yesterday",
      }),
      locale: toIntlLocaleTag(i18n.resolvedLanguage),
    });
  }, [event?.createdAt, t, i18n.resolvedLanguage]);

  const handleToggleTruncation = useCallback(
    (event: SyntheticEvent) => {
      event.stopPropagation();
      if (isExpanded) {
        messageContentRef.current?.scrollTo({ top: 0 });
      }
      setIsExpanded((prev) => !prev);
    },
    [isExpanded]
  );

  const cachedFiles: string[] = isAgentOrgInboxTranscript
    ? []
    : (event?.args?.cached_files as string[]) || [];

  const handleTogglePreview = useCallback((event: MouseEvent, file: string) => {
    event.stopPropagation();
    setPreviewFile((prev) => (prev === file ? null : file));
  }, []);

  const handleClosePreview = useCallback((event: MouseEvent) => {
    event.stopPropagation();
    setPreviewFile(null);
  }, []);

  const handleEditClick = useCallback(() => {
    setEditImageList(messageImages);
    setIsEditing(true);
  }, [messageImages]);

  const handleEditCancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleRemoveEditImage = useCallback((index: number) => {
    setEditImageList((prev) => prev?.filter((_, i) => i !== index));
  }, []);

  const handleEditSubmitInternal = useCallback(
    (newText: string, addedImageDataUrls?: string[]) => {
      setIsEditing(false);
      const rustImages = [
        ...((editImageList && editImageList.length > 0
          ? editImageList.map(imageRefToRustPath)
          : []) as string[]),
        ...(addedImageDataUrls ?? []),
      ];
      onEditSubmit?.(newText, rustImages.length > 0 ? rustImages : undefined);
    },
    [onEditSubmit, editImageList]
  );

  // Edit mode
  if (isEditing) {
    return (
      <InputArea
        isEditMode
        initialContent={editedText}
        onEditSubmit={handleEditSubmitInternal}
        onEditCancel={handleEditCancel}
        editLabel={t("input.editingSentMessage")}
        editHeaderActions={false}
        quietEditSurface
        editImages={editImageList}
        onRemoveEditImage={handleRemoveEditImage}
      />
    );
  }

  const isRepoSetup = editedText.startsWith(REPO_SETUP_PROMPT_MARKER);
  const isPlanApproved = fullContent.startsWith(PLAN_APPROVED_PREFIX);
  const planApprovedEdited =
    isPlanApproved && fullContent.startsWith("[Plan approved (edited)");
  const isEditableDisplay = Boolean(
    onEditSubmit &&
    !isRepoSetup &&
    !isAgentOrgInboxTranscript &&
    !isPlanApproved &&
    !event?.args?.["sessionDiscussion"] &&
    !readConversationSenderStamp(event)
  );
  const hasDisplayContent = Boolean(
    fullContent.trim() ||
    messageImages?.length ||
    cachedFiles.length ||
    isRepoSetup ||
    isPlanApproved
  );
  if (!hasDisplayContent) return null;

  const displayNeedsTruncation = needsTruncation;
  const senderStamp = readConversationSenderStamp(event);
  const stampIsViewer = Boolean(
    senderStamp && viewerCloudUserId && senderStamp.userId === viewerCloudUserId
  );
  const ownerSide = senderStamp
    ? stampIsViewer
      ? "right"
      : "left"
    : resolveUserMessageSide(event);
  // Only turns that would otherwise read as the viewer's own are reattributed
  // — a teammate's shared message already names its own sender and keeps it —
  // and only those the viewer did not actually submit. Someone can open a
  // subagent session and type into it; that message carries a turn-intent id
  // and stays theirs, while the parent's dispatch carries none.
  const isParentAgentMessage =
    Boolean(parentAgentSender) &&
    ownerSide === "right" &&
    !wasSubmittedByViewer(event);
  const messageSide = isParentAgentMessage ? "left" : ownerSide;
  const isRemoteSharedMessage = messageSide === "left";
  const senderName = isParentAgentMessage
    ? parentAgentSender?.parentSession?.name?.trim() ||
      t("chat.parentAgentSender")
    : senderStamp?.displayName.trim() ||
      sharedConversationSender?.displayName.trim() ||
      "Shared user";

  const containerClass = `${DISPLAY_CONTAINER_BASE} ${isEditableDisplay ? "cursor-pointer outline-none" : ""}`;
  const messageContent = (
    <UserMessageContent
      text={fullContent}
      images={messageImages}
      mentions={mentions}
    />
  );

  // Display mode
  const display = (
    <>
      <div
        className={containerClass}
        data-testid="chat-message-user-editable"
        onClick={isEditableDisplay ? handleEditClick : undefined}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
          {isRepoSetup ? (
            <div className="flex items-center gap-2 py-0.5">
              <HugeiconsIcon
                icon={SparklesIcon}
                data-icon="sparkles"
                size={14}
                className="text-primary-6"
              />
              <span className="chat-block-title font-medium text-text-1">
                {t("chat.repoSetupLabel")}
              </span>
            </div>
          ) : isPlanApproved ? (
            <div className="flex items-center gap-2 py-0.5">
              <HugeiconsIcon
                icon={ClipboardCheckIcon}
                data-icon="clipboard-check"
                size={14}
                className="text-primary-6"
              />
              <span className="chat-block-title font-medium text-text-1">
                {planApprovedEdited
                  ? t(
                      "chat.planApprovedEditedLabel",
                      "Implementing approved plan (edited)"
                    )
                  : t("chat.planApprovedLabel", "Implementing approved plan")}
              </span>
            </div>
          ) : (
            <>
              {(fullContent || (messageImages && messageImages.length > 0)) &&
                (!compactPreview ? (
                  <ClampedContent
                    maxHeight={USER_MSG_CONTINUOUS_PREVIEW_HEIGHT}
                    className="allow-select"
                  >
                    {messageContent}
                  </ClampedContent>
                ) : (
                  <div className="group/expand relative w-full">
                    <div
                      ref={messageContentRef}
                      className={`allow-select ${isExpanded && displayNeedsTruncation ? "scrollbar-hide" : ""}`}
                      style={
                        displayNeedsTruncation && !isExpanded
                          ? { maxHeight: 72, overflow: "hidden" }
                          : isExpanded && displayNeedsTruncation
                            ? {
                                maxHeight: 240,
                                overflowY: "auto",
                                overflowX: "hidden",
                              }
                            : undefined
                      }
                    >
                      {messageContent}

                      {displayNeedsTruncation && isExpanded && (
                        <ExpandOverlay
                          isExpanded
                          onToggle={handleToggleTruncation}
                          fadeFrom="from-fill-2"
                        />
                      )}
                    </div>

                    {displayNeedsTruncation && !isExpanded && (
                      <ExpandOverlay
                        isExpanded={false}
                        onToggle={handleToggleTruncation}
                        collapsedFadeHeightClass="h-8"
                        fadeFrom="from-fill-2"
                      />
                    )}
                  </div>
                ))}

              {cachedFiles.length > 0 && (
                <div className="scrollbar-x-hover flex max-w-full flex-nowrap gap-2">
                  {cachedFiles.map((file) => (
                    <CachedFileChip
                      key={file}
                      file={file}
                      isPreviewOpen={previewFile === file}
                      onTogglePreview={(event) =>
                        handleTogglePreview(event, file)
                      }
                      onClosePreview={handleClosePreview}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
      {(timestampLabel || fullContent || rawPrompt || toolbarActions) && (
        <div className="relative mt-1 flex min-h-6 items-center px-1 text-[11px] leading-none text-text-3">
          {(fullContent || rawPrompt || toolbarActions) && (
            <div
              className={`absolute top-1/2 flex -translate-y-1/2 items-center gap-1 focus-within:opacity-100 group-hover/msg:opacity-100 ${
                isRawPromptOpen ? "opacity-100" : "opacity-0"
              } ${isRemoteSharedMessage ? "left-full ml-1" : "right-full mr-1"}`}
            >
              {fullContent && (
                <ChatBubbleCopyButton
                  content={fullContent}
                  placement="toolbar"
                />
              )}
              {rawPrompt.trim() && event?.sessionId && (
                <RawPromptToggle
                  rawText={rawPrompt}
                  sessionId={event.sessionId}
                  onOpenChange={setIsRawPromptOpen}
                />
              )}
              {isEditableDisplay && onRestoreCheckpoint && (
                <button
                  type="button"
                  data-testid="chat-message-restore-checkpoint"
                  title={t("chat.restoreCheckpoint", "Restore checkpoint")}
                  className={`${CHAT_BUBBLE_TOOLBAR_BUTTON_CLASS} text-text-3 hover:text-danger-6`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRestoreCheckpoint();
                  }}
                >
                  <HugeiconsIcon
                    icon={Undo02Icon}
                    data-icon="undo-2"
                    size={15}
                    strokeWidth={1.75}
                  />
                </button>
              )}
              {isEditableDisplay && (
                <button
                  type="button"
                  data-testid="chat-message-user-edit-button"
                  className={`${CHAT_BUBBLE_TOOLBAR_BUTTON_CLASS} text-text-3 hover:text-text-1`}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleEditClick();
                  }}
                >
                  <HugeiconsIcon
                    icon={PencilEdit01Icon}
                    data-icon="pencil-line"
                    size={14}
                    strokeWidth={1.75}
                  />
                </button>
              )}
              {toolbarActions}
            </div>
          )}
          {timestampLabel}
        </div>
      )}
    </>
  );

  return (
    <div
      className={`group/msg flex w-full flex-col ${
        isRemoteSharedMessage ? "items-start pr-24" : "items-end pl-24"
      }`}
      data-message-side={messageSide}
    >
      {isRemoteSharedMessage ? (
        <div className="flex max-w-full items-start gap-2.5">
          <span
            className="mt-0.5 shrink-0"
            title={senderName}
            aria-label={senderName}
            data-testid={
              isParentAgentMessage
                ? "parent-agent-sender-avatar"
                : "shared-message-sender-avatar"
            }
          >
            {isParentAgentMessage ? (
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full"
                style={{ backgroundColor: "var(--color-fill-2)" }}
              >
                <SessionIdentityIcon
                  session={parentAgentSender?.parentSession}
                  sessionId={parentAgentSender?.parentSessionId ?? ""}
                />
              </span>
            ) : (
              <PersonAvatar
                size={28}
                name={senderName}
                src={sharedConversationSender?.avatarUrl}
              />
            )}
          </span>
          <div className="flex min-w-0 flex-col items-start">
            <span className="mb-0.5 text-xs font-medium text-text-3">
              {senderName}
            </span>
            {display}
          </div>
        </div>
      ) : (
        display
      )}
    </div>
  );
};

export default memo(UserChatItem);
