import type { Store } from "jotai/vanilla/store";
import isEqual from "lodash/isEqual";

import type { MemberEntry } from "@src/api/http/project";
import type {
  TeamInboxMention,
  TeamInboxMentionsPage,
  TeamInboxReadMutation,
} from "@src/features/Org2Cloud/teamInboxMentionsClient";
import {
  listInitialTeamInboxMentions,
  listTeamInboxMentions,
  markAllTeamInboxMentionsRead,
  setTeamInboxMentionRead,
} from "@src/features/Org2Cloud/teamInboxMentionsClient";

import {
  listLocalTeamInboxPage,
  markAllLocalTeamInboxRead,
  markLocalTeamInboxItemRead,
  markLocalTeamInboxItemUnread,
} from "./api";
import {
  dedupeTeamInboxItems,
  getTeamInboxItemKey,
  sortTeamInboxItems,
} from "./domain";
import type {
  TeamInboxCursor,
  TeamInboxFilter,
  TeamInboxIssue,
  TeamInboxItem,
} from "./domain";
import { teamInboxCacheAtom, teamInboxInvalidationAtom } from "./store";

const MAX_CACHED_TEAM_INBOX_ITEMS = 500;
const MAX_PENDING_TEAM_INBOX_MUTATIONS = 100;

interface LocalPageResult {
  page: {
    items: TeamInboxItem[];
    nextCursor: TeamInboxCursor | null;
    unreadCounts?: {
      all: number;
      mentions: number;
      assigned: number;
    };
  };
  unreadCount: number;
}

interface LocalUnreadCounts {
  all: number;
  mentions: number;
  assigned: number;
}

export interface TeamInboxCoordinatorDependencies {
  listLocalPage(
    viewerMemberIds: readonly string[],
    filter: TeamInboxFilter,
    cursor?: TeamInboxCursor | null
  ): Promise<LocalPageResult>;
  listInitialMentions(
    accessToken: string,
    orgId: string,
    limit: number,
    signal?: AbortSignal
  ): Promise<TeamInboxMentionsPage>;
  listMentions(
    accessToken: string,
    orgId: string,
    cursor: string | null,
    limit: number,
    signal?: AbortSignal
  ): Promise<TeamInboxMentionsPage>;
  markLocalRead(
    viewerMemberIds: readonly string[],
    itemId: string
  ): Promise<boolean>;
  markLocalUnread(
    viewerMemberIds: readonly string[],
    itemId: string
  ): Promise<boolean>;
  markAllLocalRead(
    viewerMemberIds: readonly string[],
    filter: TeamInboxFilter
  ): Promise<number>;
  setMentionRead(
    accessToken: string,
    orgId: string,
    commentId: string,
    read: boolean,
    signal?: AbortSignal
  ): Promise<TeamInboxReadMutation>;
  markAllMentionsRead(
    accessToken: string,
    orgId: string,
    signal?: AbortSignal
  ): Promise<TeamInboxReadMutation>;
  now(): string;
}

export interface TeamInboxCoordinatorScope {
  key: string;
  viewerMemberIds: readonly string[];
  accessToken: string | null;
  activeCloudOrgId: string | null;
  members: readonly MemberEntry[];
  /** Degraded prerequisite reads (for example, a subset of member files). */
  prerequisiteIssue?: TeamInboxIssue | null;
}

interface CoordinatorRuntime {
  scopeKey: string;
  generation: number;
  scopeController: AbortController;
  localCursor: TeamInboxCursor | null;
  cloudCursor: string | null;
  refreshPromise: Promise<void> | null;
  activeRefreshVersion: string | null;
  desiredRefreshVersion: string | null;
  queuedRefresh: { scope: TeamInboxCoordinatorScope; version: string } | null;
  loadMorePromise: Promise<void> | null;
  mutationTail: Promise<void>;
  pendingMutations: number;
  mutationEpoch: number;
  mutationEpochByItem: Map<string, number>;
  invalidationQueued: boolean;
  localUnreadCounts: LocalUnreadCounts;
  cloudUnreadCount: number;
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error })
  );
}

function errorDetail(errors: readonly unknown[]): string | undefined {
  const messages = errors
    .map((error) => (error instanceof Error ? error.message : String(error)))
    .filter(Boolean);
  return messages.length > 0 ? messages.join(" · ") : undefined;
}

function issueForFailures(
  failures: readonly unknown[],
  requestedSourceCount: number
): TeamInboxIssue | null {
  if (failures.length === 0) return null;
  return {
    code:
      failures.length >= requestedSourceCount ? "load_failed" : "partial_load",
    detail: errorDetail(failures),
  };
}

function mergeIssues(
  primary: TeamInboxIssue | null,
  secondary: TeamInboxIssue | null | undefined
): TeamInboxIssue | null {
  if (!primary) return secondary ?? null;
  if (!secondary) return primary;
  return {
    code:
      primary.code === "load_failed" || secondary.code === "load_failed"
        ? "load_failed"
        : primary.code === "identity_unresolved" ||
            secondary.code === "identity_unresolved"
          ? "identity_unresolved"
          : "partial_load",
    detail: errorDetail([primary.detail, secondary.detail].filter(Boolean)),
  };
}

function prerequisiteIssueForScope(
  scope: TeamInboxCoordinatorScope
): TeamInboxIssue | null {
  const identityIssue =
    scope.viewerMemberIds.length === 0 && scope.members.length > 0
      ? ({ code: "identity_unresolved" } as const)
      : null;
  return mergeIssues(identityIssue, scope.prerequisiteIssue);
}

function sameIssue(
  left: TeamInboxIssue | null,
  right: TeamInboxIssue | null
): boolean {
  return left?.code === right?.code && left?.detail === right?.detail;
}

function mapMentionsToItems(
  mentions: readonly TeamInboxMention[],
  activeCloudOrgId: string
): TeamInboxItem[] {
  return mentions.map((mention) => ({
    id: `cloud-comment:${activeCloudOrgId}:${mention.comment.id}`,
    kind: "comment_mention" as const,
    source: "cloud" as const,
    occurredAt: mention.createdAt,
    readAt: mention.readAt,
    actor: {
      id: mention.author.userId,
      displayName: mention.author.displayName ?? mention.author.userId,
    },
    target: {
      kind: "session_comment" as const,
      orgId: activeCloudOrgId,
      sessionId: mention.session.id,
      sessionTitle: mention.session.title ?? mention.session.id,
      commentId: mention.comment.id,
      threadId: mention.comment.parentId ?? mention.comment.id,
      anchor: mention.comment.id,
    },
    payload: {
      commentBody: mention.body,
      commentCount: mention.commentCount,
      threadCommentCount: mention.threadCount,
    },
  }));
}

export function resolveTeamInboxMemberNames(
  items: readonly TeamInboxItem[],
  members: readonly MemberEntry[]
): TeamInboxItem[] {
  if (members.length === 0) return [...items];
  const nameById = new Map(members.map((member) => [member.id, member.name]));
  return items.map((item) => {
    const actorName = nameById.get(item.actor.id);
    const nextActor =
      actorName && actorName !== item.actor.displayName
        ? { ...item.actor, displayName: actorName }
        : item.actor;
    if (item.kind === "comment_mention") {
      return nextActor === item.actor ? item : { ...item, actor: nextActor };
    }
    if (item.kind === "assigned_work_item") {
      const assigneeName = nameById.get(item.payload.assigneeMemberId);
      if (
        (!assigneeName || assigneeName === item.payload.assigneeName) &&
        nextActor === item.actor
      ) {
        return item;
      }
      return {
        ...item,
        actor: nextActor,
        payload: {
          ...item.payload,
          ...(assigneeName ? { assigneeName } : {}),
        },
      };
    }
    const recipientName = nameById.get(item.payload.recipientMemberId);
    if (
      (!recipientName || recipientName === item.payload.recipientName) &&
      nextActor === item.actor
    ) {
      return item;
    }
    return {
      ...item,
      actor: nextActor,
      payload: {
        ...item.payload,
        ...(recipientName ? { recipientName } : {}),
      },
    };
  });
}

function boundedItems(items: readonly TeamInboxItem[]): TeamInboxItem[] {
  return sortTeamInboxItems(dedupeTeamInboxItems(items)).slice(
    0,
    MAX_CACHED_TEAM_INBOX_ITEMS
  );
}

function createRuntime(scopeKey: string): CoordinatorRuntime {
  return {
    scopeKey,
    generation: 0,
    scopeController: new AbortController(),
    localCursor: null,
    cloudCursor: null,
    refreshPromise: null,
    activeRefreshVersion: null,
    desiredRefreshVersion: null,
    queuedRefresh: null,
    loadMorePromise: null,
    mutationTail: Promise.resolve(),
    pendingMutations: 0,
    mutationEpoch: 0,
    mutationEpochByItem: new Map(),
    invalidationQueued: false,
    localUnreadCounts: { all: 0, mentions: 0, assigned: 0 },
    cloudUnreadCount: 0,
  };
}

function localUnreadCounts(result: LocalPageResult): LocalUnreadCounts {
  return (
    result.page.unreadCounts ?? {
      all: result.unreadCount,
      mentions: 0,
      assigned: result.unreadCount,
    }
  );
}

/**
 * Store-scoped Team Inbox coordinator.
 *
 * All mounted consumers in one Jotai store share request identity, cursors,
 * mutation ordering and cancellation. Separate stores receive isolated runtime
 * state through the WeakMap, while persisted/cache state remains in Jotai.
 */
export class TeamInboxCoordinator {
  private readonly runtimeByStore = new WeakMap<Store, CoordinatorRuntime>();

  constructor(
    private readonly dependencies: TeamInboxCoordinatorDependencies
  ) {}

  ensureScope(store: Store, scopeKey: string): CoordinatorRuntime {
    const currentRuntime = this.runtimeByStore.get(store);
    if (currentRuntime?.scopeKey === scopeKey) return currentRuntime;

    currentRuntime?.scopeController.abort();
    const runtime = createRuntime(scopeKey);
    this.runtimeByStore.set(store, runtime);

    const cache = store.get(teamInboxCacheAtom);
    if (cache.loadedForViewerKey !== scopeKey) {
      store.set(teamInboxCacheAtom, {
        ...cache,
        items: [],
        unreadCount: 0,
        unreadCounts: { all: 0, mentions: 0, assigned: 0 },
        loading: true,
        hasMore: false,
        loadedForViewerKey: null,
        issue: null,
        revision: cache.revision + 1,
      });
    }
    return runtime;
  }

  invalidate(store: Store): void {
    const runtime = this.runtimeByStore.get(store);
    if (runtime?.invalidationQueued) return;
    if (runtime) runtime.invalidationQueued = true;
    queueMicrotask(() => {
      const latest = this.runtimeByStore.get(store);
      if (latest) latest.invalidationQueued = false;
      store.set(
        teamInboxInvalidationAtom,
        store.get(teamInboxInvalidationAtom) + 1
      );
    });
  }

  refresh(
    store: Store,
    scope: TeamInboxCoordinatorScope,
    requestVersion: string
  ): Promise<void> {
    const runtime = this.ensureScope(store, scope.key);
    runtime.desiredRefreshVersion = requestVersion;

    if (runtime.refreshPromise) {
      if (runtime.activeRefreshVersion !== requestVersion) {
        runtime.queuedRefresh = { scope, version: requestVersion };
      }
      return runtime.refreshPromise;
    }
    if (
      runtime.activeRefreshVersion === requestVersion &&
      store.get(teamInboxCacheAtom).loadedForViewerKey === scope.key
    ) {
      return Promise.resolve();
    }

    const generation = ++runtime.generation;
    runtime.activeRefreshVersion = requestVersion;
    store.set(teamInboxCacheAtom, (current) =>
      current.loadedForViewerKey === scope.key
        ? current
        : { ...current, loading: true, issue: null }
    );

    const canLoadLocal = scope.viewerMemberIds.length > 0;
    const canLoadCloud = Boolean(scope.accessToken && scope.activeCloudOrgId);
    if (!canLoadLocal && !canLoadCloud) {
      runtime.localCursor = null;
      runtime.cloudCursor = null;
      store.set(teamInboxCacheAtom, (current) => ({
        ...current,
        items: [],
        unreadCount: 0,
        unreadCounts: { all: 0, mentions: 0, assigned: 0 },
        loading: false,
        hasMore: false,
        loadedForViewerKey: scope.key,
        issue: prerequisiteIssueForScope(scope),
        revision: current.revision + 1,
      }));
      return Promise.resolve();
    }

    const requestedSourceCount = Number(canLoadLocal) + Number(canLoadCloud);
    const promise = Promise.all([
      canLoadLocal
        ? settle(
            this.dependencies.listLocalPage(scope.viewerMemberIds, "all", null)
          )
        : Promise.resolve<Settled<LocalPageResult>>({
            ok: true,
            value: {
              page: { items: [], nextCursor: null },
              unreadCount: 0,
            },
          }),
      canLoadCloud && scope.accessToken && scope.activeCloudOrgId
        ? settle(
            this.dependencies.listInitialMentions(
              scope.accessToken,
              scope.activeCloudOrgId,
              50,
              runtime.scopeController.signal
            )
          )
        : Promise.resolve<Settled<TeamInboxMentionsPage>>({
            ok: true,
            value: { mentions: [], unreadCount: 0 },
          }),
    ])
      .then(([local, cloud]) => {
        const currentRuntime = this.runtimeByStore.get(store);
        if (
          currentRuntime !== runtime ||
          generation !== runtime.generation ||
          runtime.scopeController.signal.aborted ||
          runtime.desiredRefreshVersion !== requestVersion
        ) {
          return;
        }

        const previous = store.get(teamInboxCacheAtom);
        const sameScope = previous.loadedForViewerKey === scope.key;
        const previousLocal = sameScope
          ? previous.items.filter((item) => item.source !== "cloud")
          : [];
        const previousCloud = sameScope
          ? previous.items.filter((item) => item.source === "cloud")
          : [];
        const failures = [
          ...(local.ok ? [] : [local.error]),
          ...(cloud.ok ? [] : [cloud.error]),
        ];

        const localItems = local.ok ? local.value.page.items : previousLocal;
        const cloudItems = cloud.ok
          ? mapMentionsToItems(
              cloud.value.mentions,
              scope.activeCloudOrgId ?? ""
            )
          : previousCloud;
        if (local.ok) {
          runtime.localUnreadCounts = localUnreadCounts(local.value);
        }
        if (cloud.ok) {
          runtime.cloudUnreadCount = cloud.value.unreadCount;
        }
        const localUnread = runtime.localUnreadCounts;
        const cloudUnread = runtime.cloudUnreadCount;

        if (local.ok) runtime.localCursor = local.value.page.nextCursor;
        if (cloud.ok) runtime.cloudCursor = cloud.value.nextCursor ?? null;

        const items = boundedItems(
          resolveTeamInboxMemberNames(
            [...cloudItems, ...localItems],
            scope.members
          )
        );
        if (items.length >= MAX_CACHED_TEAM_INBOX_ITEMS) {
          runtime.localCursor = null;
          runtime.cloudCursor = null;
        }
        const unreadCount = localUnread.all + cloudUnread;
        const issue = mergeIssues(
          issueForFailures(failures, requestedSourceCount),
          prerequisiteIssueForScope(scope)
        );
        const hasMore = Boolean(runtime.localCursor || runtime.cloudCursor);
        store.set(teamInboxCacheAtom, (current) => {
          const itemsUnchanged = isEqual(current.items, items);
          const snapshotUnchanged =
            itemsUnchanged &&
            current.unreadCount === unreadCount &&
            current.unreadCounts.all === unreadCount &&
            current.unreadCounts.mentions ===
              localUnread.mentions + cloudUnread &&
            current.unreadCounts.assigned === localUnread.assigned &&
            !current.loading &&
            sameIssue(current.issue, issue) &&
            current.loadedForViewerKey === scope.key &&
            current.hasMore === hasMore;
          if (snapshotUnchanged) return current;
          return {
            ...current,
            items: itemsUnchanged ? current.items : items,
            unreadCount,
            unreadCounts: {
              all: unreadCount,
              mentions: localUnread.mentions + cloudUnread,
              assigned: localUnread.assigned,
            },
            loading: false,
            issue,
            loadedForViewerKey: scope.key,
            hasMore,
            revision: current.revision + 1,
          };
        });
      })
      .finally(() => {
        if (runtime.refreshPromise === promise) {
          runtime.refreshPromise = null;
        }
        const queued = runtime.queuedRefresh;
        runtime.queuedRefresh = null;
        if (
          queued &&
          this.runtimeByStore.get(store) === runtime &&
          !runtime.scopeController.signal.aborted
        ) {
          void this.refresh(store, queued.scope, queued.version);
        }
      });
    runtime.refreshPromise = promise;
    return promise;
  }

  loadMore(store: Store, scope: TeamInboxCoordinatorScope): Promise<void> {
    const runtime = this.ensureScope(store, scope.key);
    if (runtime.loadMorePromise) return runtime.loadMorePromise;
    const localCursor = runtime.localCursor;
    const cloudCursor = runtime.cloudCursor;
    if (!localCursor && !cloudCursor) return Promise.resolve();

    const generation = runtime.generation;
    const requestedSourceCount =
      Number(Boolean(localCursor)) + Number(Boolean(cloudCursor));
    const promise = Promise.all([
      localCursor
        ? settle(
            this.dependencies.listLocalPage(
              scope.viewerMemberIds,
              "all",
              localCursor
            )
          )
        : Promise.resolve<Settled<LocalPageResult>>({
            ok: true,
            value: {
              page: { items: [], nextCursor: null },
              unreadCount: runtime.localUnreadCounts.all,
            },
          }),
      cloudCursor && scope.accessToken && scope.activeCloudOrgId
        ? settle(
            this.dependencies.listMentions(
              scope.accessToken,
              scope.activeCloudOrgId,
              cloudCursor,
              50,
              runtime.scopeController.signal
            )
          )
        : Promise.resolve<Settled<TeamInboxMentionsPage>>({
            ok: true,
            value: {
              mentions: [],
              unreadCount: store.get(teamInboxCacheAtom).unreadCounts.mentions,
            },
          }),
    ])
      .then(([local, cloud]) => {
        if (
          this.runtimeByStore.get(store) !== runtime ||
          generation !== runtime.generation ||
          runtime.scopeController.signal.aborted
        ) {
          return;
        }
        const failures = [
          ...(local.ok ? [] : [local.error]),
          ...(cloud.ok ? [] : [cloud.error]),
        ];
        if (localCursor && local.ok) {
          runtime.localCursor = local.value.page.nextCursor;
          runtime.localUnreadCounts = localUnreadCounts(local.value);
        }
        if (cloudCursor && cloud.ok) {
          runtime.cloudCursor = cloud.value.nextCursor ?? null;
          runtime.cloudUnreadCount = cloud.value.unreadCount;
        }
        const appended = resolveTeamInboxMemberNames(
          [
            ...(cloud.ok
              ? mapMentionsToItems(
                  cloud.value.mentions,
                  scope.activeCloudOrgId ?? ""
                )
              : []),
            ...(local.ok ? local.value.page.items : []),
          ],
          scope.members
        );
        store.set(teamInboxCacheAtom, (current) => {
          const items = boundedItems([...current.items, ...appended]);
          if (items.length >= MAX_CACHED_TEAM_INBOX_ITEMS) {
            runtime.localCursor = null;
            runtime.cloudCursor = null;
          }
          const assigned = runtime.localUnreadCounts.assigned;
          const mentions =
            runtime.localUnreadCounts.mentions + runtime.cloudUnreadCount;
          const all = runtime.localUnreadCounts.all + runtime.cloudUnreadCount;
          return {
            ...current,
            items,
            unreadCount: all,
            unreadCounts: {
              all,
              assigned,
              mentions,
            },
            issue: mergeIssues(
              issueForFailures(failures, requestedSourceCount),
              prerequisiteIssueForScope(scope)
            ),
            hasMore: Boolean(runtime.localCursor || runtime.cloudCursor),
            revision: current.revision + 1,
          };
        });
        if (failures.length >= requestedSourceCount) {
          throw new Error(errorDetail(failures) ?? "Team Inbox load failed");
        }
      })
      .finally(() => {
        if (runtime.loadMorePromise === promise) {
          runtime.loadMorePromise = null;
        }
      });
    runtime.loadMorePromise = promise;
    return promise;
  }

  markRead(
    store: Store,
    scope: TeamInboxCoordinatorScope,
    item: TeamInboxItem
  ): Promise<void> {
    return this.setReadState(store, scope, item, true);
  }

  markUnread(
    store: Store,
    scope: TeamInboxCoordinatorScope,
    item: TeamInboxItem
  ): Promise<void> {
    return this.setReadState(store, scope, item, false);
  }

  private setReadState(
    store: Store,
    scope: TeamInboxCoordinatorScope,
    item: TeamInboxItem,
    read: boolean
  ): Promise<void> {
    const runtime = this.ensureScope(store, scope.key);
    const itemKey = getTeamInboxItemKey(item);
    // Idempotency lives here, not just at the call site, so any caller —
    // including future ones — can't double-fire a read/unread mutation and
    // send a redundant network round-trip that risks drifting unreadCount.
    // Check the live cache rather than the passed-in `item`, which may be a
    // stale snapshot from the caller's render.
    const currentItem = store
      .get(teamInboxCacheAtom)
      .items.find((candidate) => getTeamInboxItemKey(candidate) === itemKey);
    const currentlyRead = (currentItem ?? item).readAt !== null;
    if (currentlyRead === read) {
      return Promise.resolve();
    }
    const epoch = ++runtime.mutationEpoch;
    runtime.mutationEpochByItem.set(itemKey, epoch);
    this.patchReadState(
      store,
      scope.key,
      itemKey,
      read ? this.dependencies.now() : null
    );

    return this.enqueueMutation(runtime, async () => {
      try {
        let cloudResult: TeamInboxReadMutation | null = null;
        if (item.kind === "comment_mention") {
          if (!scope.accessToken || !scope.activeCloudOrgId) {
            throw new Error("Cloud identity is unavailable");
          }
          cloudResult = await this.dependencies.setMentionRead(
            scope.accessToken,
            scope.activeCloudOrgId,
            item.target.commentId,
            read,
            runtime.scopeController.signal
          );
        } else {
          const updated = read
            ? await this.dependencies.markLocalRead(
                scope.viewerMemberIds,
                item.id
              )
            : await this.dependencies.markLocalUnread(
                scope.viewerMemberIds,
                item.id
              );
          if (!updated)
            throw new Error("Assigned Work Item is no longer visible");
        }
        if (
          this.runtimeByStore.get(store) !== runtime ||
          runtime.scopeController.signal.aborted ||
          runtime.mutationEpochByItem.get(itemKey) !== epoch
        ) {
          return;
        }
        if (cloudResult) {
          const authoritativeReadAt = read
            ? (cloudResult.readAt ?? this.dependencies.now())
            : null;
          this.patchReadState(
            store,
            scope.key,
            itemKey,
            authoritativeReadAt,
            cloudResult.unreadCount
          );
        }
      } catch (error) {
        if (
          this.runtimeByStore.get(store) === runtime &&
          !runtime.scopeController.signal.aborted &&
          runtime.mutationEpochByItem.get(itemKey) === epoch
        ) {
          this.patchReadState(
            store,
            scope.key,
            itemKey,
            read ? null : item.readAt
          );
        }
        throw error;
      } finally {
        if (runtime.mutationEpochByItem.get(itemKey) === epoch) {
          runtime.mutationEpochByItem.delete(itemKey);
        }
      }
    });
  }

  markAllRead(
    store: Store,
    scope: TeamInboxCoordinatorScope,
    filter: TeamInboxFilter
  ): Promise<void> {
    const runtime = this.ensureScope(store, scope.key);
    return this.enqueueMutation(runtime, async () => {
      if (filter === "archived") return;
      const includeCloudMentions = filter === "all" || filter === "mentions";
      const localUnreadForFilter =
        filter === "all"
          ? runtime.localUnreadCounts.all
          : filter === "mentions"
            ? runtime.localUnreadCounts.mentions
            : runtime.localUnreadCounts.assigned;
      const [local, cloud] = await Promise.all([
        localUnreadForFilter > 0
          ? settle(
              this.dependencies.markAllLocalRead(scope.viewerMemberIds, filter)
            )
          : Promise.resolve<Settled<number>>({ ok: true, value: 0 }),
        includeCloudMentions && runtime.cloudUnreadCount > 0
          ? scope.accessToken && scope.activeCloudOrgId
            ? settle(
                this.dependencies.markAllMentionsRead(
                  scope.accessToken,
                  scope.activeCloudOrgId,
                  runtime.scopeController.signal
                )
              )
            : Promise.resolve<Settled<TeamInboxReadMutation>>({
                ok: false,
                error: new Error("Cloud identity is unavailable"),
              })
          : Promise.resolve<Settled<TeamInboxReadMutation>>({
              ok: true,
              value: { readAt: null, unreadCount: 0 },
            }),
      ]);
      if (
        this.runtimeByStore.get(store) !== runtime ||
        runtime.scopeController.signal.aborted
      ) {
        return;
      }
      const readAt = cloud.ok
        ? (cloud.value.readAt ?? this.dependencies.now())
        : this.dependencies.now();
      if (local.ok) {
        if (filter === "all") {
          runtime.localUnreadCounts = { all: 0, mentions: 0, assigned: 0 };
        } else if (filter === "mentions") {
          runtime.localUnreadCounts = {
            ...runtime.localUnreadCounts,
            all: Math.max(
              0,
              runtime.localUnreadCounts.all - runtime.localUnreadCounts.mentions
            ),
            mentions: 0,
          };
        } else {
          runtime.localUnreadCounts = {
            ...runtime.localUnreadCounts,
            all: Math.max(
              0,
              runtime.localUnreadCounts.all - runtime.localUnreadCounts.assigned
            ),
            assigned: 0,
          };
        }
      }
      if (includeCloudMentions && cloud.ok) {
        runtime.cloudUnreadCount = cloud.value.unreadCount;
      }
      store.set(teamInboxCacheAtom, (current) => {
        const assigned = runtime.localUnreadCounts.assigned;
        const mentions =
          runtime.localUnreadCounts.mentions + runtime.cloudUnreadCount;
        const all = runtime.localUnreadCounts.all + runtime.cloudUnreadCount;
        return {
          ...current,
          items: current.items.map((candidate) => {
            const shouldMark =
              (local.ok &&
                candidate.source !== "cloud" &&
                (filter === "all" ||
                  (filter === "assigned" &&
                    candidate.kind === "assigned_work_item") ||
                  (filter === "mentions" &&
                    candidate.kind === "comment_mention"))) ||
              (includeCloudMentions &&
                cloud.ok &&
                candidate.source === "cloud" &&
                candidate.kind === "comment_mention");
            return shouldMark ? { ...candidate, readAt } : candidate;
          }),
          unreadCount: all,
          unreadCounts: { all, assigned, mentions },
          revision: current.revision + 1,
        };
      });
      const failures = [
        ...(local.ok ? [] : [local.error]),
        ...(cloud.ok ? [] : [cloud.error]),
      ];
      if (failures.length > 0) {
        throw new Error(errorDetail(failures) ?? "Team Inbox update failed");
      }
    });
  }

  reconcileItem(
    store: Store,
    scopeKey: string,
    itemKey: string,
    nextItem: TeamInboxItem | null
  ): void {
    const previousSnapshot = store.get(teamInboxCacheAtom);
    const previousSnapshotItem = previousSnapshot.items.find(
      (candidate) => getTeamInboxItemKey(candidate) === itemKey
    );
    const unreadDelta =
      Number(nextItem?.readAt === null) -
      Number(previousSnapshotItem?.readAt === null);
    const runtime = this.runtimeByStore.get(store);
    if (runtime?.scopeKey === scopeKey && unreadDelta !== 0) {
      const affectedItem = previousSnapshotItem ?? nextItem;
      if (affectedItem?.source === "cloud") {
        runtime.cloudUnreadCount = Math.max(
          0,
          runtime.cloudUnreadCount + unreadDelta
        );
      } else if (affectedItem) {
        runtime.localUnreadCounts = {
          all: Math.max(0, runtime.localUnreadCounts.all + unreadDelta),
          mentions:
            affectedItem.kind === "comment_mention"
              ? Math.max(0, runtime.localUnreadCounts.mentions + unreadDelta)
              : runtime.localUnreadCounts.mentions,
          assigned:
            affectedItem.kind === "assigned_work_item"
              ? Math.max(0, runtime.localUnreadCounts.assigned + unreadDelta)
              : runtime.localUnreadCounts.assigned,
        };
      }
    }
    store.set(teamInboxCacheAtom, (current) => {
      if (current.loadedForViewerKey !== scopeKey) return current;
      const previousItem = current.items.find(
        (candidate) => getTeamInboxItemKey(candidate) === itemKey
      );
      const nextItems = previousItem
        ? current.items.flatMap((candidate) =>
            getTeamInboxItemKey(candidate) === itemKey
              ? nextItem
                ? [nextItem]
                : []
              : [candidate]
          )
        : nextItem
          ? [...current.items, nextItem]
          : current.items;
      const previousUnread = previousItem?.readAt === null ? 1 : 0;
      const nextUnread = nextItem?.readAt === null ? 1 : 0;
      const unreadDelta = nextUnread - previousUnread;
      const runtimeMatches = runtime?.scopeKey === scopeKey;
      const assigned = runtimeMatches
        ? runtime.localUnreadCounts.assigned
        : previousItem?.kind === "assigned_work_item" ||
            nextItem?.kind === "assigned_work_item"
          ? Math.max(0, current.unreadCounts.assigned + unreadDelta)
          : current.unreadCounts.assigned;
      const mentions = runtimeMatches
        ? runtime.localUnreadCounts.mentions + runtime.cloudUnreadCount
        : previousItem?.kind === "comment_mention" ||
            nextItem?.kind === "comment_mention"
          ? Math.max(0, current.unreadCounts.mentions + unreadDelta)
          : current.unreadCounts.mentions;
      const all = runtimeMatches
        ? runtime.localUnreadCounts.all + runtime.cloudUnreadCount
        : Math.max(0, current.unreadCounts.all + unreadDelta);
      return {
        ...current,
        items: boundedItems(nextItems),
        unreadCount: all,
        unreadCounts: { all, assigned, mentions },
        revision: current.revision + 1,
      };
    });
  }

  private enqueueMutation<T>(
    runtime: CoordinatorRuntime,
    operation: () => Promise<T>
  ): Promise<T> {
    if (runtime.pendingMutations >= MAX_PENDING_TEAM_INBOX_MUTATIONS) {
      return Promise.reject(new Error("Too many pending Team Inbox updates"));
    }
    runtime.pendingMutations += 1;
    const run = async (): Promise<T> => {
      try {
        return await operation();
      } finally {
        runtime.pendingMutations = Math.max(0, runtime.pendingMutations - 1);
      }
    };
    const result = runtime.mutationTail.then(run, run);
    runtime.mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private patchReadState(
    store: Store,
    scopeKey: string,
    itemKey: string,
    readAt: string | null,
    authoritativeMentionUnread?: number
  ): void {
    const cachedCandidate = store
      .get(teamInboxCacheAtom)
      .items.find((item) => getTeamInboxItemKey(item) === itemKey);
    const runtime = this.runtimeByStore.get(store);
    if (cachedCandidate && runtime?.scopeKey === scopeKey) {
      const delta =
        Number(readAt === null) - Number(cachedCandidate.readAt === null);
      if (cachedCandidate.source === "cloud") {
        runtime.cloudUnreadCount =
          authoritativeMentionUnread ??
          Math.max(0, runtime.cloudUnreadCount + delta);
      } else {
        runtime.localUnreadCounts = {
          all: Math.max(0, runtime.localUnreadCounts.all + delta),
          mentions:
            cachedCandidate.kind === "comment_mention"
              ? Math.max(0, runtime.localUnreadCounts.mentions + delta)
              : runtime.localUnreadCounts.mentions,
          assigned:
            cachedCandidate.kind === "assigned_work_item"
              ? Math.max(0, runtime.localUnreadCounts.assigned + delta)
              : runtime.localUnreadCounts.assigned,
        };
      }
    }
    store.set(teamInboxCacheAtom, (current) => {
      if (current.loadedForViewerKey !== scopeKey) return current;
      const candidate = current.items.find(
        (item) => getTeamInboxItemKey(item) === itemKey
      );
      if (!candidate) return current;
      const wasUnread = candidate.readAt === null;
      const willBeUnread = readAt === null;
      const delta = Number(willBeUnread) - Number(wasUnread);
      const currentRuntime = this.runtimeByStore.get(store);
      const runtimeMatches = currentRuntime?.scopeKey === scopeKey;
      const assigned = runtimeMatches
        ? currentRuntime.localUnreadCounts.assigned
        : candidate.kind === "assigned_work_item"
          ? Math.max(0, current.unreadCounts.assigned + delta)
          : current.unreadCounts.assigned;
      const mentions = runtimeMatches
        ? currentRuntime.localUnreadCounts.mentions +
          currentRuntime.cloudUnreadCount
        : candidate.kind === "comment_mention"
          ? (authoritativeMentionUnread ??
            Math.max(0, current.unreadCounts.mentions + delta))
          : current.unreadCounts.mentions;
      const all = runtimeMatches
        ? currentRuntime.localUnreadCounts.all + currentRuntime.cloudUnreadCount
        : Math.max(0, current.unreadCounts.all + delta);
      return {
        ...current,
        items: current.items.map((item) =>
          getTeamInboxItemKey(item) === itemKey ? { ...item, readAt } : item
        ),
        unreadCount: all,
        unreadCounts: { all, assigned, mentions },
        revision: current.revision + 1,
      };
    });
  }
}

const productionDependencies: TeamInboxCoordinatorDependencies = {
  listLocalPage: listLocalTeamInboxPage,
  listInitialMentions: listInitialTeamInboxMentions,
  listMentions: listTeamInboxMentions,
  markLocalRead: markLocalTeamInboxItemRead,
  markLocalUnread: markLocalTeamInboxItemUnread,
  markAllLocalRead: markAllLocalTeamInboxRead,
  setMentionRead: setTeamInboxMentionRead,
  markAllMentionsRead: markAllTeamInboxMentionsRead,
  now: () => new Date().toISOString(),
};

export const teamInboxCoordinator = new TeamInboxCoordinator(
  productionDependencies
);

export const TEAM_INBOX_CACHE_LIMIT = MAX_CACHED_TEAM_INBOX_ITEMS;
