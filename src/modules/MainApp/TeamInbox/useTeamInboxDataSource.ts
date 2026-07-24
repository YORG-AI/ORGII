import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { invalidateProjectCache, projectApi } from "@src/api/http/project";
import type { MemberEntry } from "@src/api/http/project";
import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  org2CloudCommentsSignalAtom,
  orgCommentsKey,
} from "@src/features/Org2Cloud/org2CloudCommentsBus";
import { sidebarActiveCloudOrgIdAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  type TeamInboxMention,
  listTeamInboxMentions,
} from "@src/features/Org2Cloud/teamInboxMentionsClient";
import { useProjectDataChanged } from "@src/hooks/project";
import { useCurrentUserMemberIds } from "@src/hooks/project/useCurrentUserMemberId";

import {
  listLocalTeamInboxPage,
  markAllLocalTeamInboxRead,
  markLocalTeamInboxItemRead,
  markLocalTeamInboxItemUnread,
} from "./api";
import { dedupeTeamInboxItems } from "./domain";
import type {
  TeamInboxCursor,
  TeamInboxDataSource,
  TeamInboxFilter,
  TeamInboxItem,
} from "./domain";
import {
  type TeamInboxCloudReadReceipts,
  addTeamInboxCloudReadReceipts,
  invalidateTeamInboxAtom,
  removeTeamInboxCloudReadReceipts,
  teamInboxCacheAtom,
  teamInboxCloudReadReceiptsAtom,
  teamInboxInvalidationAtom,
} from "./store";

const listeners = new Set<() => void>();
let membersRequest: Promise<MemberEntry[]> | null = null;
let inboxRequest: {
  key: string;
  promise: Promise<{
    mentionItems: TeamInboxItem[];
    localItems: TeamInboxItem[];
    localUnread: number;
    localNextCursor: TeamInboxCursor | null;
    cloudNextCursor: string | null;
  }>;
} | null = null;

function notifyTeamInboxListeners(): void {
  for (const listener of listeners) listener();
}

/**
 * Maps raw cloud mentions into Team Inbox items with `readAt` left unresolved;
 * the caller overlays the latest local read receipts afterwards. Shared by the
 * initial load and `loadMore` so both pages produce identical item shapes.
 */
function mapMentionsToItems(
  mentions: readonly TeamInboxMention[],
  activeCloudOrgId: string
): TeamInboxItem[] {
  return mentions.map((mention) => {
    const itemId = `cloud-comment:${activeCloudOrgId}:${mention.comment.id}`;
    return {
      id: itemId,
      kind: "comment_mention" as const,
      occurredAt: mention.createdAt,
      readAt: null,
      actor: {
        id: mention.author.userId,
        displayName: mention.author.displayName ?? "Team member",
      },
      target: {
        kind: "session_comment" as const,
        sessionId: mention.session.id,
        sessionTitle: mention.session.title ?? "Session",
        commentId: mention.comment.id,
        threadId: mention.comment.parentId ?? mention.comment.id,
        anchor: mention.comment.id,
      },
      payload: {
        commentBody: mention.body,
        commentCount: mention.commentCount,
        context: `${mention.threadCount} thread comments`,
      },
    };
  });
}

/** Overlays the current cloud read receipts onto freshly-mapped mention items. */
function overlayCloudReadReceipts(
  mentionItems: readonly TeamInboxItem[],
  cloudReadReceipts: TeamInboxCloudReadReceipts,
  cloudScopeKey: string
): TeamInboxItem[] {
  return mentionItems.map((item) => ({
    ...item,
    readAt: cloudReadReceipts[`${cloudScopeKey}|${item.id}`] ?? null,
  }));
}

/**
 * Resolves each assigned item's display name from its stable `assigneeMemberId`
 * into the optional `assigneeName` field. When the member cannot be resolved the
 * name is left unset and consumers fall back to the id, so a row never renders
 * blank.
 */
function resolveAssigneeDisplayNames(
  items: readonly TeamInboxItem[],
  members: readonly MemberEntry[]
): TeamInboxItem[] {
  if (members.length === 0) return [...items];
  const nameById = new Map(members.map((member) => [member.id, member.name]));
  return items.map((item) => {
    if (item.kind !== "assigned_work_item") return item;
    const resolved = nameById.get(item.payload.assigneeMemberId);
    if (!resolved || resolved === item.payload.assigneeName) return item;
    return {
      ...item,
      payload: { ...item.payload, assigneeName: resolved },
    };
  });
}

async function readAllProjectMembers(): Promise<MemberEntry[]> {
  if (membersRequest) return membersRequest;
  membersRequest = (async () => {
    const projects = await projectApi.readProjects();
    const memberFiles = await Promise.all(
      projects.map((project) => projectApi.readMembers(project.slug))
    );
    const members = new Map<string, MemberEntry>();
    for (const file of memberFiles) {
      for (const member of file.members) members.set(member.id, member);
    }
    return [...members.values()];
  })();
  try {
    return await membersRequest;
  } finally {
    membersRequest = null;
  }
}

export function useTeamInboxDataSource(): {
  dataSource: TeamInboxDataSource;
  viewerMemberIds: readonly string[];
} {
  const [members, setMembers] = useState<MemberEntry[]>([]);
  const membersRef = useRef<MemberEntry[]>([]);
  const { memberIds } = useCurrentUserMemberIds(members);
  const viewerMemberIds = useMemo(() => [...memberIds].sort(), [memberIds]);
  const cache = useAtomValue(teamInboxCacheAtom);
  const auth = useAtomValue(org2CloudAuthAtom);
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const activeCloudOrgId = useAtomValue(sidebarActiveCloudOrgIdAtom);
  const viewerKey = `${viewerMemberIds.join("|")}::${authIdentityKey ?? "signed-out"}::${activeCloudOrgId ?? "local"}`;
  const commentsSignals = useAtomValue(org2CloudCommentsSignalAtom);
  const cloudReadReceipts = useAtomValue(teamInboxCloudReadReceiptsAtom);
  const setCloudReadReceipts = useSetAtom(teamInboxCloudReadReceiptsAtom);
  const activeCloudCommentsRevision = activeCloudOrgId
    ? (commentsSignals[orgCommentsKey(activeCloudOrgId)] ?? 0)
    : 0;
  const invalidation = useAtomValue(teamInboxInvalidationAtom);
  const setCache = useSetAtom(teamInboxCacheAtom);
  const invalidate = useSetAtom(invalidateTeamInboxAtom);
  const loadGeneration = useRef(0);
  const localCursorRef = useRef<TeamInboxCursor | null>(null);
  const cloudCursorRef = useRef<string | null>(null);
  const loadingMoreRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void readAllProjectMembers()
      .then((nextMembers) => {
        if (!cancelled) {
          membersRef.current = nextMembers;
          setMembers(nextMembers);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setCache((current) => ({
            ...current,
            error:
              error instanceof Error
                ? error.message
                : "Failed to resolve current Team Inbox member identity",
          }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [invalidation, setCache]);

  const refresh = useCallback(async (): Promise<void> => {
    const canLoadLocalAssignments = viewerMemberIds.length > 0;
    const canLoadCloudMentions = Boolean(auth && activeCloudOrgId);
    if (!canLoadLocalAssignments && !canLoadCloudMentions) {
      localCursorRef.current = null;
      cloudCursorRef.current = null;
      setCache((current) => ({
        ...current,
        items: [],
        unreadCount: 0,
        loading: false,
        hasMore: false,
        loadedForViewerKey: viewerKey,
        error:
          members.length > 0
            ? "No project member matches the current Git identity"
            : null,
      }));
      notifyTeamInboxListeners();
      return;
    }
    const generation = ++loadGeneration.current;
    setCache((current) => ({ ...current, loading: true, error: null }));
    try {
      const requestKey = viewerKey;
      if (!inboxRequest || inboxRequest.key !== requestKey) {
        const promise = Promise.all([
          canLoadLocalAssignments
            ? listLocalTeamInboxPage(viewerMemberIds, "all")
            : Promise.resolve({
                page: { items: [], nextCursor: null },
                unreadCount: 0,
              }),
          auth && activeCloudOrgId
            ? listTeamInboxMentions(
                auth.accessToken,
                activeCloudOrgId,
                null,
                50
              ).catch(() => ({ mentions: [], nextCursor: undefined }))
            : Promise.resolve({ mentions: [], nextCursor: undefined }),
        ]).then(([{ page, unreadCount }, mentionPage]) => {
          // Read state is intentionally NOT baked in here: the cached request
          // promise stays receipt-independent so a mention marked read while
          // this request is in flight is not reverted when the page resolves.
          // The current cloud read receipts are overlaid after the await below.
          const mentionItems = mapMentionsToItems(
            mentionPage.mentions,
            activeCloudOrgId ?? ""
          );
          return {
            mentionItems,
            localItems: page.items,
            localUnread: unreadCount,
            localNextCursor: page.nextCursor,
            cloudNextCursor: mentionPage.nextCursor ?? null,
          };
        });
        inboxRequest = { key: requestKey, promise };
        void promise.finally(() => {
          if (inboxRequest?.promise === promise) inboxRequest = null;
        });
      }
      const {
        mentionItems,
        localItems,
        localUnread,
        localNextCursor,
        cloudNextCursor,
      } = await inboxRequest.promise;
      if (generation !== loadGeneration.current) return;
      localCursorRef.current = localNextCursor;
      cloudCursorRef.current = cloudNextCursor;
      // Overlay the latest cloud read receipts here (not inside the cached
      // request promise) so optimistic mark-read/unread survives a concurrent
      // in-flight list request.
      const cloudScopeKey = `${authIdentityKey ?? "signed-out"}|${activeCloudOrgId ?? "local"}`;
      const overlaidMentions = overlayCloudReadReceipts(
        mentionItems,
        cloudReadReceipts,
        cloudScopeKey
      );
      const mergedItems = [...overlaidMentions, ...localItems];
      const unreadCount =
        localUnread +
        overlaidMentions.filter((item) => item.readAt === null).length;
      const resolvedItems = resolveAssigneeDisplayNames(
        mergedItems,
        membersRef.current
      );
      setCache((current) => ({
        ...current,
        items: resolvedItems,
        unreadCount,
        loading: false,
        error: null,
        loadedForViewerKey: viewerKey,
        hasMore: Boolean(localNextCursor || cloudNextCursor),
        revision: current.revision + 1,
      }));
      notifyTeamInboxListeners();
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      setCache((current) => ({
        ...current,
        loading: false,
        error:
          error instanceof Error ? error.message : "Failed to load Team Inbox",
      }));
      notifyTeamInboxListeners();
    }
  }, [
    activeCloudOrgId,
    auth,
    authIdentityKey,
    cloudReadReceipts,
    members.length,
    setCache,
    viewerKey,
    viewerMemberIds,
  ]);

  useEffect(() => {
    if (activeCloudCommentsRevision > 0) void refresh();
  }, [activeCloudCommentsRevision, refresh]);
  useEffect(() => {
    if (cache.loadedForViewerKey === viewerKey && invalidation === 0) return;
    void refresh();
  }, [cache.loadedForViewerKey, invalidation, refresh, viewerKey]);

  useProjectDataChanged(() => invalidate());

  const dataSource = useMemo<TeamInboxDataSource>(
    () => ({
      listPage: async () => {
        if (cache.error && cache.items.length === 0)
          throw new Error(cache.error);
        // A non-null nextCursor signals the view that a further page exists; the
        // exact value is a sentinel because `loadMore` owns the real per-source
        // cursors internally.
        return {
          items: cache.items,
          nextCursor: cache.hasMore
            ? { occurredAt: "", itemKey: "team-inbox-has-more" }
            : null,
        };
      },
      loadMore: async () => {
        if (loadingMoreRef.current) return;
        const localCursor = localCursorRef.current;
        const cloudCursor = cloudCursorRef.current;
        if (!localCursor && !cloudCursor) return;
        loadingMoreRef.current = true;
        try {
          const [localResult, cloudResult] = await Promise.all([
            localCursor && viewerMemberIds.length > 0
              ? listLocalTeamInboxPage(viewerMemberIds, "all", localCursor)
              : Promise.resolve({
                  page: { items: [], nextCursor: null },
                  unreadCount: 0,
                }),
            cloudCursor && auth && activeCloudOrgId
              ? listTeamInboxMentions(
                  auth.accessToken,
                  activeCloudOrgId,
                  cloudCursor,
                  50
                ).catch(() => ({ mentions: [], nextCursor: undefined }))
              : Promise.resolve({ mentions: [], nextCursor: undefined }),
          ]);
          localCursorRef.current = localResult.page.nextCursor ?? null;
          cloudCursorRef.current = cloudResult.nextCursor ?? null;
          const cloudScopeKey = `${authIdentityKey ?? "signed-out"}|${activeCloudOrgId ?? "local"}`;
          const appendedMentions = overlayCloudReadReceipts(
            mapMentionsToItems(cloudResult.mentions, activeCloudOrgId ?? ""),
            cloudReadReceipts,
            cloudScopeKey
          );
          const appended = resolveAssigneeDisplayNames(
            [...appendedMentions, ...localResult.page.items],
            membersRef.current
          );
          // Unread badge semantics are intentionally left unchanged here (the
          // single-source-of-truth question is tracked separately); loadMore
          // only extends the loaded window.
          setCache((current) => ({
            ...current,
            items: dedupeTeamInboxItems([...current.items, ...appended]),
            hasMore: Boolean(localCursorRef.current || cloudCursorRef.current),
            revision: current.revision + 1,
          }));
          notifyTeamInboxListeners();
        } finally {
          loadingMoreRef.current = false;
        }
      },
      refresh: async () => {
        invalidateProjectCache();
        membersRequest = null;
        const nextMembers = await readAllProjectMembers();
        membersRef.current = nextMembers;
        setMembers(nextMembers);
        setCache((current) => ({
          ...current,
          loadedForViewerKey: null,
          loading: true,
          error: null,
        }));
        invalidate();
      },
      markRead: async (item: TeamInboxItem) => {
        const readAt = new Date().toISOString();
        if (item.kind === "comment_mention") {
          const cloudScopeKey = `${authIdentityKey ?? "signed-out"}|${activeCloudOrgId ?? "local"}`;
          setCloudReadReceipts((current) =>
            addTeamInboxCloudReadReceipts(current, {
              [`${cloudScopeKey}|${item.id}`]: readAt,
            })
          );
        } else {
          await markLocalTeamInboxItemRead(viewerMemberIds, item.id);
        }
        setCache((current) => ({
          ...current,
          items: current.items.map((candidate) =>
            candidate.id === item.id ? { ...candidate, readAt } : candidate
          ),
          unreadCount: Math.max(0, current.unreadCount - 1),
          revision: current.revision + 1,
        }));
        notifyTeamInboxListeners();
      },
      markUnread: async (item: TeamInboxItem) => {
        if (item.kind === "comment_mention") {
          const cloudScopeKey = `${authIdentityKey ?? "signed-out"}|${activeCloudOrgId ?? "local"}`;
          setCloudReadReceipts((current) =>
            removeTeamInboxCloudReadReceipts(current, [
              `${cloudScopeKey}|${item.id}`,
            ])
          );
        } else {
          await markLocalTeamInboxItemUnread(viewerMemberIds, item.id);
        }
        setCache((current) => ({
          ...current,
          items: current.items.map((candidate) =>
            candidate.id === item.id
              ? { ...candidate, readAt: null }
              : candidate
          ),
          unreadCount: current.unreadCount + 1,
          revision: current.revision + 1,
        }));
        notifyTeamInboxListeners();
      },
      markAllRead: async (items) => {
        const assigned = items.filter(
          (
            item
          ): item is Extract<TeamInboxItem, { kind: "assigned_work_item" }> =>
            item.kind === "assigned_work_item"
        );
        if (assigned.length > 0) {
          await markAllLocalTeamInboxRead(viewerMemberIds, "assigned");
        }
        const readAt = new Date().toISOString();
        const cloudScopeKey = `${authIdentityKey ?? "signed-out"}|${activeCloudOrgId ?? "local"}`;
        const mentionReceipts = items
          .filter((item) => item.kind === "comment_mention")
          .reduce<Record<string, string>>((next, item) => {
            next[`${cloudScopeKey}|${item.id}`] = readAt;
            return next;
          }, {});
        if (Object.keys(mentionReceipts).length > 0) {
          setCloudReadReceipts((current) =>
            addTeamInboxCloudReadReceipts(current, mentionReceipts)
          );
        }
        const itemIds = new Set(items.map((item) => item.id));
        // Decrement only by the items that were actually unread; counting the
        // whole set would over-subtract when some passed items were already read.
        const newlyReadCount = items.reduce(
          (count, item) => count + (item.readAt === null ? 1 : 0),
          0
        );
        setCache((current) => ({
          ...current,
          items: current.items.map((item) =>
            itemIds.has(item.id) ? { ...item, readAt } : item
          ),
          unreadCount: Math.max(0, current.unreadCount - newlyReadCount),
          revision: current.revision + 1,
        }));
        notifyTeamInboxListeners();
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    [
      activeCloudOrgId,
      auth,
      authIdentityKey,
      cache.error,
      cache.hasMore,
      cache.items,
      cloudReadReceipts,
      invalidate,
      setCache,
      setCloudReadReceipts,
      viewerMemberIds,
    ]
  );

  return { dataSource, viewerMemberIds };
}

export function filterForItem(item: TeamInboxItem): TeamInboxFilter {
  return item.kind === "comment_mention" ? "mentions" : "assigned";
}
