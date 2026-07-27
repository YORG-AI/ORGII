import { useAtomValue, useSetAtom } from "jotai";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
  listInitialTeamInboxMentions,
  listTeamInboxMentions,
  markAllTeamInboxMentionsRead,
  setTeamInboxMentionRead,
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
  invalidateTeamInboxAtom,
  teamInboxCacheAtom,
  teamInboxInvalidationAtom,
} from "./store";

const listeners = new Set<() => void>();
const MAX_PENDING_TEAM_INBOX_MUTATIONS = 100;
let membersRequest: Promise<MemberEntry[]> | null = null;
let inboxRequest: {
  key: string;
  promise: Promise<{
    mentionItems: TeamInboxItem[];
    localItems: TeamInboxItem[];
    localUnread: number;
    cloudUnread: number;
    localNextCursor: TeamInboxCursor | null;
    cloudNextCursor: string | null;
  }>;
} | null = null;

const EMPTY_CLOUD_MENTION_PAGE = {
  mentions: [],
  nextCursor: undefined,
  unreadCount: 0,
} as const;

function notifyTeamInboxListeners(): void {
  for (const listener of listeners) listener();
}

/**
 * Maps the server-authoritative cloud mention projection into Team Inbox
 * items. Shared by initial load and pagination so both paths stay identical.
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
      readAt: mention.readAt,
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
  const mutationQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingMutationCountRef = useRef(0);

  const enqueueMutation = useCallback(
    <T>(operation: () => Promise<T>): Promise<T> => {
      if (pendingMutationCountRef.current >= MAX_PENDING_TEAM_INBOX_MUTATIONS) {
        return Promise.reject(
          new Error("Too many pending Team Inbox updates; try again shortly")
        );
      }
      pendingMutationCountRef.current += 1;
      const run = async (): Promise<T> => {
        try {
          return await operation();
        } finally {
          pendingMutationCountRef.current = Math.max(
            0,
            pendingMutationCountRef.current - 1
          );
        }
      };
      const result = mutationQueueRef.current.then(run, run);
      mutationQueueRef.current = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
    []
  );

  useLayoutEffect(() => {
    if (
      cache.loadedForViewerKey === null ||
      cache.loadedForViewerKey === viewerKey
    ) {
      return;
    }

    // Never render the previous account/org projection while the new identity
    // is revalidating. Bump the generation first so late page/mutation
    // completions cannot repopulate the evicted cache.
    loadGeneration.current += 1;
    localCursorRef.current = null;
    cloudCursorRef.current = null;
    loadingMoreRef.current = false;
    setCache((current) =>
      current.loadedForViewerKey === viewerKey
        ? current
        : {
            ...current,
            items: [],
            unreadCount: 0,
            unreadCounts: { all: 0, mentions: 0, assigned: 0 },
            loading: true,
            hasMore: false,
            loadedForViewerKey: null,
            error: null,
            revision: current.revision + 1,
          }
    );
  }, [cache.loadedForViewerKey, setCache, viewerKey]);

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
        unreadCounts: { all: 0, mentions: 0, assigned: 0 },
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
            ? listInitialTeamInboxMentions(
                auth.accessToken,
                activeCloudOrgId,
                50
              )
            : Promise.resolve(EMPTY_CLOUD_MENTION_PAGE),
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
            cloudUnread: mentionPage.unreadCount,
            localNextCursor: page.nextCursor,
            cloudNextCursor: mentionPage.nextCursor ?? null,
          };
        });
        inboxRequest = { key: requestKey, promise };
        const clearSettledRequest = () => {
          if (inboxRequest?.promise === promise) inboxRequest = null;
        };
        void promise.then(clearSettledRequest, clearSettledRequest);
      }
      const {
        mentionItems,
        localItems,
        localUnread,
        cloudUnread,
        localNextCursor,
        cloudNextCursor,
      } = await inboxRequest.promise;
      if (generation !== loadGeneration.current) return;
      localCursorRef.current = localNextCursor;
      cloudCursorRef.current = cloudNextCursor;
      const mergedItems = [...mentionItems, ...localItems];
      const unreadCount = localUnread + cloudUnread;
      const resolvedItems = resolveAssigneeDisplayNames(
        mergedItems,
        membersRef.current
      );
      setCache((current) => ({
        ...current,
        items: resolvedItems,
        unreadCount,
        unreadCounts: {
          all: unreadCount,
          mentions: cloudUnread,
          assigned: localUnread,
        },
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
          unreadCounts: cache.unreadCounts,
          nextCursor: cache.hasMore
            ? { occurredAt: "", itemKey: "team-inbox-has-more" }
            : null,
        };
      },
      loadMore: async () => {
        if (loadingMoreRef.current) return;
        const generation = loadGeneration.current;
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
                )
              : Promise.resolve({
                  mentions: [],
                  nextCursor: undefined,
                  unreadCount: cache.unreadCounts.mentions,
                }),
          ]);
          if (generation !== loadGeneration.current) return;
          localCursorRef.current = localResult.page.nextCursor ?? null;
          cloudCursorRef.current = cloudResult.nextCursor ?? null;
          const appendedMentions = mapMentionsToItems(
            cloudResult.mentions,
            activeCloudOrgId ?? ""
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
        const generation = loadGeneration.current;
        return enqueueMutation(async () => {
          let readAt = new Date().toISOString();
          let cloudUnread: number | null = null;
          if (item.kind === "comment_mention") {
            if (!auth || !activeCloudOrgId) {
              throw new Error(
                "Cloud identity is required to mark a mention read"
              );
            }
            const result = await setTeamInboxMentionRead(
              auth.accessToken,
              activeCloudOrgId,
              item.target.commentId,
              true
            );
            readAt = result.readAt ?? readAt;
            cloudUnread = result.unreadCount;
          } else {
            await markLocalTeamInboxItemRead(viewerMemberIds, item.id);
          }
          if (generation !== loadGeneration.current) return;
          setCache((current) => {
            const wasUnread =
              current.items.find((candidate) => candidate.id === item.id)
                ?.readAt === null;
            const assignedUnread =
              item.kind === "comment_mention"
                ? current.unreadCounts.assigned
                : Math.max(
                    0,
                    current.unreadCounts.assigned - (wasUnread ? 1 : 0)
                  );
            const mentionUnread =
              item.kind === "comment_mention"
                ? (cloudUnread ?? current.unreadCounts.mentions)
                : current.unreadCounts.mentions;
            return {
              ...current,
              items: current.items.map((candidate) =>
                candidate.id === item.id ? { ...candidate, readAt } : candidate
              ),
              unreadCounts: {
                all: assignedUnread + mentionUnread,
                assigned: assignedUnread,
                mentions: mentionUnread,
              },
              unreadCount: assignedUnread + mentionUnread,
              revision: current.revision + 1,
            };
          });
          notifyTeamInboxListeners();
        });
      },
      markUnread: async (item: TeamInboxItem) => {
        const generation = loadGeneration.current;
        return enqueueMutation(async () => {
          let cloudUnread: number | null = null;
          if (item.kind === "comment_mention") {
            if (!auth || !activeCloudOrgId) {
              throw new Error(
                "Cloud identity is required to mark a mention unread"
              );
            }
            const result = await setTeamInboxMentionRead(
              auth.accessToken,
              activeCloudOrgId,
              item.target.commentId,
              false
            );
            cloudUnread = result.unreadCount;
          } else {
            await markLocalTeamInboxItemUnread(viewerMemberIds, item.id);
          }
          if (generation !== loadGeneration.current) return;
          setCache((current) => {
            const wasUnread =
              current.items.find((candidate) => candidate.id === item.id)
                ?.readAt === null;
            const assignedUnread =
              item.kind === "comment_mention"
                ? current.unreadCounts.assigned
                : current.unreadCounts.assigned + (wasUnread ? 0 : 1);
            const mentionUnread =
              item.kind === "comment_mention"
                ? (cloudUnread ?? current.unreadCounts.mentions)
                : current.unreadCounts.mentions;
            return {
              ...current,
              items: current.items.map((candidate) =>
                candidate.id === item.id
                  ? { ...candidate, readAt: null }
                  : candidate
              ),
              unreadCounts: {
                all: assignedUnread + mentionUnread,
                assigned: assignedUnread,
                mentions: mentionUnread,
              },
              unreadCount: assignedUnread + mentionUnread,
              revision: current.revision + 1,
            };
          });
          notifyTeamInboxListeners();
        });
      },
      markAllRead: async (_items, filter = "all") => {
        const generation = loadGeneration.current;
        return enqueueMutation(async () => {
          const includeAssigned = filter === "all" || filter === "assigned";
          const includeMentions = filter === "all" || filter === "mentions";
          let cloudReadAt: string | null = null;
          let cloudUnread: number | null = null;
          if (
            includeMentions &&
            cache.unreadCounts.mentions > 0 &&
            (!auth || !activeCloudOrgId)
          ) {
            throw new Error(
              "Cloud identity is required to mark all mentions read"
            );
          }
          try {
            const [, cloudResult] = await Promise.all([
              includeAssigned && cache.unreadCounts.assigned > 0
                ? markAllLocalTeamInboxRead(viewerMemberIds, "assigned")
                : Promise.resolve(),
              includeMentions &&
              cache.unreadCounts.mentions > 0 &&
              auth &&
              activeCloudOrgId
                ? markAllTeamInboxMentionsRead(
                    auth.accessToken,
                    activeCloudOrgId
                  )
                : Promise.resolve(null),
            ]);
            cloudReadAt = cloudResult?.readAt ?? null;
            cloudUnread = cloudResult?.unreadCount ?? null;
          } catch (error) {
            invalidate();
            throw error;
          }
          if (generation !== loadGeneration.current) return;
          const readAt = cloudReadAt ?? new Date().toISOString();
          setCache((current) => {
            const assignedUnread = includeAssigned
              ? 0
              : current.unreadCounts.assigned;
            const mentionUnread = includeMentions
              ? (cloudUnread ?? 0)
              : current.unreadCounts.mentions;
            return {
              ...current,
              items: current.items.map((item) =>
                (includeAssigned && item.kind === "assigned_work_item") ||
                (includeMentions && item.kind === "comment_mention")
                  ? { ...item, readAt }
                  : item
              ),
              unreadCounts: {
                all: assignedUnread + mentionUnread,
                assigned: assignedUnread,
                mentions: mentionUnread,
              },
              unreadCount: assignedUnread + mentionUnread,
              revision: current.revision + 1,
            };
          });
          notifyTeamInboxListeners();
        });
      },
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    [
      activeCloudOrgId,
      auth,
      cache.error,
      cache.hasMore,
      cache.items,
      cache.unreadCounts,
      enqueueMutation,
      invalidate,
      setCache,
      viewerMemberIds,
    ]
  );

  return { dataSource, viewerMemberIds };
}

export function filterForItem(item: TeamInboxItem): TeamInboxFilter {
  return item.kind === "comment_mention" ? "mentions" : "assigned";
}
