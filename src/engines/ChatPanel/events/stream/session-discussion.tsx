import React from "react";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { discussionPayloadOf } from "@src/features/Org2Cloud/SessionConversation/discussionEvents";
import { MarkdownContent } from "@src/modules/shared/components/MarkdownContent";

function initialOf(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
}

function timeLabel(createdAt: string): string {
  const ms = new Date(createdAt).getTime();
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function SessionDiscussionEvent({
  event,
}: {
  event: SessionEvent;
}): React.ReactElement | null {
  const payload = discussionPayloadOf(event);
  if (!payload) return null;

  const isAgentReport = payload.kind === "agent_report";
  const authorName = isAgentReport
    ? "Agent"
    : payload.authorDisplayName?.trim() || payload.authorUserId;

  return (
    <div
      className="flex gap-2.5 rounded-lg bg-fill-1 px-3 py-2"
      data-discussion-comment-id={payload.commentId}
    >
      <div
        className={`mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium leading-none ${
          isAgentReport
            ? "bg-primary-1 text-primary-7"
            : "bg-fill-3 text-text-2"
        }`}
      >
        {isAgentReport ? "✦" : initialOf(authorName)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-xs text-text-3">
          <span className="font-medium text-text-2">{authorName}</span>
          <span>{timeLabel(event.createdAt)}</span>
          {payload.editedAt && <span>(已编辑)</span>}
          {payload.resolvedAt && <span>已解决</span>}
        </div>
        {payload.anchorOrphaned && (
          <div className="mt-0.5 text-xs italic text-text-3">
            回复较早版本的内容
          </div>
        )}
        {payload.anchorExcerpt && (
          <div className="mt-0.5 truncate border-l-2 border-primary-3 pl-2 text-xs text-text-3">
            {payload.anchorExcerpt}
          </div>
        )}
        <MarkdownContent
          body={payload.body}
          clamped={false}
          className="mt-1 text-sm"
        />
      </div>
    </div>
  );
}
