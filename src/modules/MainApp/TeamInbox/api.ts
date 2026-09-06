import { invoke } from "@tauri-apps/api/core";

import type { WorkItemHandoff } from "@src/api/http/project";

import { toWireCursorItemId } from "./domain";
import type {
  TeamInboxCursor,
  TeamInboxFilter,
  TeamInboxItem,
  TeamInboxNotificationKind,
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
      repository?: string;
    }
  | {
      type: "work_item_comment";
      workItemId: string;
      shortId: string;
      orgId: string;
      projectId?: string;
      projectSlug?: string;
      commentId: string;
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
      handoff?: WorkItemHandoff;
    }
  | {
      type: "work_item_updated";
      title: string;
      eventKind: string;
      status: string;
      priority: string;
      recipientMemberId: string;
      summary?: string;
    };

interface TeamInboxWireItem {
  id: string;
  kind:
    | "comment_mention"
    | "work_item_assigned"
    | "work_item_updated"
    | "work_item_run_failed";
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
  unreadCounts?: {
    all: number;
    mentions: number;
    assigned: number;
    updates: number;
  };
}

function toIso(timestamp: number | undefined): string | null {
  return timestamp === undefined ? null : new Date(timestamp).toISOString();
}

function mapWireItem(item: TeamInboxWireItem): TeamInboxItem {
  const occurredAt = new Date(item.occurredAt).toISOString();
  const actor = item.actor ?? {
    id: "system",
    displayName: "",
  };

  if (
    item.kind === "comment_mention" &&
    item.payload.type === "comment_mention"
  ) {
    if (item.target.type === "work_item_comment") {
      return {
        id: item.id,
        kind: "comment_mention",
        source: "local",
        occurredAt,
        readAt: toIso(item.readAt),
        actor,
        target: {
          kind: "work_item_comment",
          orgId: item.target.orgId,
          projectId: item.target.projectSlug ?? item.target.projectId ?? "",
          workItemId: item.target.shortId,
          workItemTitle: item.payload.sessionTitle,
          commentId: item.target.commentId,
        },
        payload: {
          commentBody: item.payload.commentExcerpt,
          commentCount: item.payload.commentCount,
        },
      };
    }
    if (item.target.type !== "comment") {
      throw new Error(`Unsupported comment mention target: ${item.id}`);
    }
    return {
      id: item.id,
      kind: "comment_mention",
      source: "local",
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
    (item.kind === "work_item_updated" ||
      item.kind === "work_item_run_failed") &&
    item.target.type === "work_item" &&
    item.payload.type === "work_item_updated"
  ) {
    const eventKind = item.payload.eventKind;
    return {
      id: item.id,
      kind:
        eventKind === "child_completed"
          ? "child_completed"
          : item.kind === "work_item_run_failed"
            ? "work_item_run_failed"
            : "work_item_updated",
      source: "local",
      occurredAt,
      readAt: toIso(item.readAt),
      actor,
      target: {
        kind: "work_item",
        orgId: item.target.orgId,
        projectId: item.target.projectSlug ?? item.target.projectId ?? "",
        workItemId: item.target.shortId,
        ...(item.target.repository
          ? { repository: item.target.repository }
          : {}),
      },
      payload: {
        title: item.payload.title,
        eventKind,
        status: item.payload.status,
        priority: item.payload.priority,
        recipientMemberId: item.payload.recipientMemberId,
        summary: item.payload.summary,
        updatedAt: occurredAt,
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
      source: "local",
      occurredAt,
      readAt: toIso(item.readAt),
      actor,
      target: {
        kind: "work_item",
        orgId: item.target.orgId,
        projectId: item.target.projectSlug ?? item.target.projectId ?? "",
        workItemId: item.target.shortId,
        ...(item.target.repository
          ? { repository: item.target.repository }
          : {}),
      },
      payload: {
        title: item.payload.title,
        status: item.payload.status,
        priority: item.payload.priority,
        assigneeMemberId: item.payload.assigneeMemberId,
        summary: item.payload.summary,
        updatedAt: occurredAt,
        handoff: item.payload.handoff,
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
      unreadCounts: wire.unreadCounts
        ? {
            all: wire.unreadCounts.all,
            mentions: wire.unreadCounts.mentions,
            assigned: wire.unreadCounts.assigned,
          }
        : undefined,
    },
    unreadCount: wire.unreadCount,
  };
}

export async function archiveLocalTeamInboxItem(
  viewerMemberIds: readonly string[],
  itemId: string
): Promise<boolean> {
  return invoke<boolean>("team_inbox_archive", {
    viewerMemberIds: [...viewerMemberIds],
    itemId,
  });
}

export async function unarchiveLocalTeamInboxItem(
  viewerMemberIds: readonly string[],
  itemId: string
): Promise<boolean> {
  return invoke<boolean>("team_inbox_unarchive", {
    viewerMemberIds: [...viewerMemberIds],
    itemId,
  });
}

export async function listLocalTeamInboxMutedKinds(
  viewerMemberIds: readonly string[]
): Promise<TeamInboxNotificationKind[]> {
  if (viewerMemberIds.length === 0) return [];
  const results = await Promise.all(
    viewerMemberIds.map((recipientId) =>
      invoke<string[]>("team_inbox_list_muted_kinds", { recipientId })
    )
  );
  const mutedForEveryIdentity = results[0].filter((kind) =>
    results.every((result) => result.includes(kind))
  );
  return mutedForEveryIdentity as TeamInboxNotificationKind[];
}

export async function setLocalTeamInboxKindMuted(
  viewerMemberIds: readonly string[],
  kind: TeamInboxNotificationKind,
  muted: boolean
): Promise<TeamInboxNotificationKind[]> {
  await Promise.all(
    viewerMemberIds.map((recipientId) =>
      invoke<string[]>("team_inbox_set_kind_muted", {
        recipientId,
        kind,
        muted,
      })
    )
  );
  return listLocalTeamInboxMutedKinds(viewerMemberIds);
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
