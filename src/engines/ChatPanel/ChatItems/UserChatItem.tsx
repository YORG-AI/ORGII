import {
  ClipboardCheck,
  File,
  Image,
  PencilLine,
  Sparkles,
  Undo2,
} from "lucide-react";
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

import Avatar from "@src/components/Avatar";
import {
  CHAT_BUBBLE_TOOLBAR_BUTTON_CLASS,
  ChatBubbleCopyButton,
} from "@src/components/ChatBubble";
import ExpandOverlay from "@src/components/ExpandOverlay";
import { readPillText } from "@src/config/pillTokens";
import { REPO_SETUP_PROMPT_MARKER } from "@src/config/repoSetupMarker";
import type { OptimizedChatItem } from "@src/engines/ChatPanel/ChatHistory/chatItemPipeline/types";
import {
  SessionLinkCard,
  type SessionLinkCardData,
} from "@src/engines/ChatPanel/blocks/ToolCallBlock/cards";
import { createCollabAvatarIdentity } from "@src/store/collaboration/protocol";
import {
  formatSmartDateTime,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";
import { imageRefToRustPath } from "@src/util/file/imageRefs";

import UserMessageContent from "../ChatHistory/components/UserMessageContent";
import InputArea from "../InputArea";
import { stripExpandedPillContent } from "../InputArea/utils/pillContentParser";
import { useSharedConversationSender } from "./SharedConversationSenderContext";
import { normalizeUserMessageText } from "./normalizeUserMessageText";
import { resolveUserMessageSide } from "./userMessageSide";

const USER_MSG_MAX_LINES = 3;
const USER_MSG_MAX_CHARS = 120;
const AGENT_ORG_INBOX_TRANSCRIPT_PREFIX = "Acknowledged inbox batch";
const PLAN_APPROVED_PREFIX = "[Plan approved";

const PR_PILL_REGEX = /[^\n[]+?\s*\[pr:(pr:\/\/\d+)\]/g;

function extractPrPillCards(text: string): SessionLinkCardData[] {
  const cards: SessionLinkCardData[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(PR_PILL_REGEX)) {
    const pillPath = match[1];
    if (!pillPath || seen.has(pillPath)) continue;
    seen.add(pillPath);
    const stored = readPillText(pillPath);
    if (!stored) continue;
    try {
      const prData = JSON.parse(stored) as {
        prNumber: number;
        prTitle: string;
        prUrl: string;
        prStatus: string;
        sourceBranch?: string;
        targetBranch?: string;
        additions?: number;
        deletions?: number;
      };
      const repoMatch = prData.prUrl.match(
        /github\.com\/([^/]+\/[^/]+)\/pull\//
      );
      const repoFullName = repoMatch?.[1] ?? "";
      const status = prData.prStatus as SessionLinkCardData["prStatus"];
      cards.push({
        prUrl: prData.prUrl,
        prStatus: status,
        repoFullName,
        prNumber: prData.prNumber,
        prTitle: prData.prTitle,
        sourceBranch: prData.sourceBranch,
        targetBranch: prData.targetBranch,
        additions: prData.additions,
        deletions: prData.deletions,
      });
    } catch {
      // Malformed stored data — skip
    }
  }
  return cards;
}

// ============================================
// Types
// ============================================

interface UserChatItemProps {
  chatItem: OptimizedChatItem;
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
          <Image size={13} strokeWidth={1.75} className="text-text-2" />
        ) : (
          <File size={13} strokeWidth={1.75} className="text-text-2" />
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
              <File size={32} strokeWidth={1.75} color="#888" />
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
  onEditSubmit,
  toolbarActions,
  onRestoreCheckpoint,
}: UserChatItemProps) => {
  const { t, i18n } = useTranslation("sessions");
  const sharedConversationSender = useSharedConversationSender();
  const [isEditing, setIsEditing] = useState(false);

  const [isExpanded, setIsExpanded] = useState(false);
  const [previewFile, setPreviewFile] = useState<string | null>(null);
  // Editable copy of the message's attached images; seeded on edit entry so
  // the user can remove stale duplicates before resending.
  const [editImageList, setEditImageList] = useState<string[] | undefined>(
    undefined
  );
  const messageContentRef = useRef<HTMLDivElement | null>(null);

  const event = chatItem.event;
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
    const textToCheck = fullContent || editedText;
    if (!textToCheck) return false;
    if (textToCheck.split("\n").length > USER_MSG_MAX_LINES) return true;
    return textToCheck.length > USER_MSG_MAX_CHARS;
  }, [editedText, fullContent]);

  const prPillCards = useMemo(
    () => extractPrPillCards(fullContent),
    [fullContent]
  );

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
    !isPlanApproved
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
  const messageSide = resolveUserMessageSide(event);
  const isRemoteSharedMessage = messageSide === "left";
  const senderName =
    sharedConversationSender?.displayName.trim() || "Shared user";
  const senderAvatar = createCollabAvatarIdentity(senderName);

  const containerClass = `${DISPLAY_CONTAINER_BASE} ${isEditableDisplay ? "cursor-pointer outline-none" : ""}`;

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
              <Sparkles size={14} className="text-primary-6" />
              <span className="chat-block-title font-medium text-text-1">
                {t("chat.repoSetupLabel")}
              </span>
            </div>
          ) : isPlanApproved ? (
            <div className="flex items-center gap-2 py-0.5">
              <ClipboardCheck size={14} className="text-primary-6" />
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
              {(fullContent || (messageImages && messageImages.length > 0)) && (
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
                    <UserMessageContent
                      text={fullContent}
                      images={messageImages}
                    />

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
              )}

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
      {(timestampLabel || fullContent || toolbarActions) && (
        <div className="relative mt-1 flex min-h-6 items-center px-1 text-[11px] leading-none text-text-3">
          {(fullContent || toolbarActions) && (
            <div
              className={`absolute top-1/2 flex -translate-y-1/2 items-center gap-1 opacity-0 focus-within:opacity-100 group-hover/msg:opacity-100 ${
                isRemoteSharedMessage ? "left-full ml-1" : "right-full mr-1"
              }`}
            >
              {fullContent && (
                <ChatBubbleCopyButton
                  content={fullContent}
                  placement="toolbar"
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
                  <Undo2 size={15} strokeWidth={1.75} />
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
                  <PencilLine size={14} strokeWidth={1.75} />
                </button>
              )}
              {toolbarActions}
            </div>
          )}
          {timestampLabel}
        </div>
      )}
      {prPillCards.length > 0 && (
        <div className="mt-1 flex w-full max-w-2xl flex-col">
          {prPillCards.map((card) => (
            <SessionLinkCard
              key={`${card.repoFullName}#${card.prNumber}`}
              card={card}
            />
          ))}
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
            data-testid="shared-message-sender-avatar"
          >
            <Avatar
              size={28}
              src={sharedConversationSender?.avatarUrl}
              style={{ backgroundColor: "var(--color-fill-2)" }}
            >
              {senderAvatar.initials}
            </Avatar>
          </span>
          <div className="flex min-w-0 flex-col items-start">{display}</div>
        </div>
      ) : (
        display
      )}
    </div>
  );
};

export default memo(UserChatItem);
