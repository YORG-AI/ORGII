/**
 * UserMessageContent
 *
 * Renders user message text with ordinary links and session cards.
 * Parses the serialized pill format: `displayName [type:path]`
 * produced by ComposerInput.getTextWithPills().
 */
import React, { memo, useMemo } from "react";

import { ChatImageThumbnailRow } from "@src/components/ChatImageThumbnail";
import SessionReferenceCards from "@src/components/MarkDown/SessionReferenceCards";
import { projectMarkdownSessionReferences } from "@src/components/MarkDown/sessionReferenceProjection";
import { PILL_LINE_HEIGHT } from "@src/config/pillTokens";
import { normalizeUserMessageText } from "@src/engines/ChatPanel/ChatItems/normalizeUserMessageText";
import CanvasDomComponentPreview from "@src/features/DomSelection/CanvasDomComponentPreview";
import { parseCanvasDomComponent } from "@src/features/DomSelection/domComponentPayload";

import { InlineReferenceLink, MentionPill } from "./UserMessagePills";
import {
  type PillSegment,
  type UserMessageMention,
  normalizeMarkdownReferencePills,
  parseNormalizedUserMessage,
  splitMentionSegments,
} from "./userMessageSegments";

export type { UserMessageMention } from "./userMessageSegments";
export {
  normalizeMarkdownReferencePills,
  normalizeMarkdownUrlPills,
  parseUserMessage,
  splitMentionSegments,
} from "./userMessageSegments";

// ============================================
// Main Component
// ============================================

interface UserMessageContentProps {
  text: string;
  /** Optional image URLs (data URLs or Tauri asset URLs) attached to this message */
  images?: string[];
  /** Known @-mentions of this message, rendered as member pills. */
  mentions?: readonly UserMessageMention[];
}

const TEXT_BASE_CLASS =
  "whitespace-pre-wrap break-words text-[14px] leading-relaxed text-text-1";

const UserMessageContent: React.FC<UserMessageContentProps> = memo(
  ({ text, images, mentions }) => {
    const normalizedText = useMemo(
      () =>
        normalizeMarkdownReferencePills(normalizeUserMessageText(text, images)),
      [images, text]
    );
    const sessionProjection = useMemo(
      () => projectMarkdownSessionReferences(normalizedText),
      [normalizedText]
    );
    const segments = useMemo(() => {
      const parsed = parseNormalizedUserMessage(sessionProjection.text);
      return mentions?.length ? splitMentionSegments(parsed, mentions) : parsed;
    }, [mentions, sessionProjection.text]);
    const hasImages = images && images.length > 0;
    const canvasSelectionJson = segments.find(
      (segment): segment is PillSegment =>
        segment.kind === "pill" &&
        segment.pillType === "dom-component" &&
        parseCanvasDomComponent(segment.terminalText) !== null
    )?.terminalText;

    // Fast path: no pills and no images, render plain text
    const hasPills = segments.some((s) => s.kind !== "text");
    if (!hasPills && !hasImages && sessionProjection.references.length === 0) {
      return <span className={TEXT_BASE_CLASS}>{sessionProjection.text}</span>;
    }

    return (
      <div className="flex flex-col gap-2">
        {hasImages && <ChatImageThumbnailRow images={images} />}
        {canvasSelectionJson && (
          <CanvasDomComponentPreview jsonText={canvasSelectionJson} />
        )}
        {sessionProjection.text && sessionProjection.text !== "(image)" && (
          <span
            className="whitespace-pre-wrap break-words text-[14px] text-text-1"
            style={{ lineHeight: PILL_LINE_HEIGHT }}
          >
            {segments.map((segment, idx) =>
              segment.kind === "text" ? (
                <React.Fragment key={idx}>{segment.text}</React.Fragment>
              ) : segment.kind === "mention" ? (
                <MentionPill key={idx} segment={segment} />
              ) : (
                <InlineReferenceLink key={idx} segment={segment} />
              )
            )}
          </span>
        )}
        {sessionProjection.references.length > 0 ? (
          <SessionReferenceCards references={sessionProjection.references} />
        ) : null}
      </div>
    );
  }
);
UserMessageContent.displayName = "UserMessageContent";

export default UserMessageContent;
