import { invoke } from "@tauri-apps/api/core";

import { toWireCursorItemId } from "./domain";
import type {
  TeamInboxCursor,
  TeamInboxFilter,
  TeamInboxItem,
  TeamInboxPage,
} from "./domain";

interface TeamInboxWireCursor {
  occurredAt: number;
  itemId: string;
}

interface TeamInboxWireActor {
  id: string;
  displayName: string;
  avatarUrl?: string;
}

type TeamInboxWireTarget =
  | {
      type: "comment";
      sessionId: string;
      commentId: string;
      anchor?: string;
    }
  | {
      type: "work_item";
      workItemId: string;
      shortId: string;
      orgId: string;
      projectId?: string;
      projectSlug?: string;
    };

type TeamInboxWirePayload =
  | {
      type: "comment_mention";
      sessionTitle: string;
      commentExcerpt: string;
      commentCount: number;
    }
  | {
      type: "work_item_assigned";
      title: string;
      status: string;
      priority: string;
      assigneeMemberId: string;
      summary?: string;
    };

interface TeamInboxWireItem {
  id: string;
  kind: "comment_mention" | "work_item_assigned";
  occurredAt: number;
  readAt?: number;
  actor?: TeamInboxWireActor;
  target: TeamInboxWireTarget;
  payload: TeamInboxWirePayload;
}

interface TeamInboxWirePage {
  items: TeamInboxWireItem[];
  nextCursor?: TeamInboxWireCursor;
  unreadCount: number;
}

function toIso(timestamp: number | undefined): string | null {
  return timestamp === undefined ? null : new Date(timestamp).toISOString();
}

function mapWireItem(item: TeamInboxWireItem): TeamInboxItem {
  const occurredAt = new Date(item.occurredAt).toISOString();
  const actor = item.actor ?? {
    id: "system",
    displayName: "Team Inbox",
  };

  if (
    item.kind === "comment_mention" &&
    item.target.type === "comment" &&
    item.payload.type === "comment_mention"
  ) {
    return {
      id: item.id,
      kind: "comment_mention",
      occurredAt,
      readAt: toIso(item.readAt),
      actor,
      target: {
        kind: "session_comment",
        sessionId: item.target.sessionId,
        sessionTitle: item.payload.sessionTitle,
        commentId: item.target.commentId,
        threadId: item.target.commentId,
        anchor: item.target.anchor,
      },
      payload: {
        commentBody: item.payload.commentExcerpt,
        commentCount: item.payload.commentCount,
      },
    };
  }

  if (
    item.kind === "work_item_assigned" &&
    item.target.type === "work_item" &&
    item.payload.type === "work_item_assigned"
  ) {
    return {
      id: item.id,
      kind: "assigned_work_item",
      occurredAt,
      readAt: toIso(item.readAt),
      actor,
      target: {
        kind: "work_item",
        projectId: item.target.projectSlug ?? item.target.projectId ?? "",
        workItemId: item.target.shortId,
      },
      payload: {
        title: item.payload.title,
        status: item.payload.status,
        priority: item.payload.priority,
        assigneeMemberId: item.payload.assigneeMemberId,
        summary: item.payload.summary,
        updatedAt: occurredAt,
      },
    };
  }

  throw new Error(`Unsupported Team Inbox wire item: ${item.id}`);
}

function toWireCursor(
  cursor?: TeamInboxCursor | null
): TeamInboxWireCursor | null {
  if (!cursor) return null;
  return {
    occurredAt: Date.parse(cursor.occurredAt),
    itemId: toWireCursorItemId(cursor.itemKey),
  };
}

export async function listLocalTeamInboxPage(
  viewerMemberIds: readonly string[],
  filter: TeamInboxFilter,
  cursor?: TeamInboxCursor | null,
  limit = 50
): Promise<{ page: TeamInboxPage; unreadCount: number }> {
  const wire = await invoke<TeamInboxWirePage>("team_inbox_list_page", {
    viewerMemberIds: [...viewerMemberIds],
    filter,
    cursor: toWireCursor(cursor),
    limit,
  });
  return {
    page: {
      items: wire.items.map(mapWireItem),
      nextCursor: wire.nextCursor
        ? {
            occurredAt: new Date(wire.nextCursor.occurredAt).toISOString(),
            itemKey: wire.nextCursor.itemId,
          }
        : null,
    },
    unreadCount: wire.unreadCount,
  };
}

export async function markLocalTeamInboxItemRead(
  viewerMemberIds: readonly string[],
  itemId: string
): Promise<boolean> {
  return invoke<boolean>("team_inbox_mark_read", {
    viewerMemberIds: [...viewerMemberIds],
    itemId,
  });
}

export async function markAllLocalTeamInboxRead(
  viewerMemberIds: readonly string[],
  filter: TeamInboxFilter
): Promise<number> {
  return invoke<number>("team_inbox_mark_all_read", {
    viewerMemberIds: [...viewerMemberIds],
    filter,
  });
}

export async function markLocalTeamInboxItemUnread(
  viewerMemberIds: readonly string[],
  itemId: string
): Promise<boolean> {
  return invoke<boolean>("team_inbox_mark_unread", {
    viewerMemberIds: [...viewerMemberIds],
    itemId,
  });
}
