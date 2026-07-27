/**
 * Session Loaders
 *
 * Two complementary loading paths:
 *
 *  - `loadSessions()` — legacy "load everything (with limit/offset)" entry
 *    used by panels that want a single flat list across all categories
 *    (Chat history panel, Simulator panel, useSessionManager).
 *
 *  - `loadSessionRoster()` / `loadMoreCategory()` — the shared incremental
 *    roster consumed by Sidebar and every session Kanban mode. Native
 *    categories fetch one top-N page; imported sources fetch lightweight,
 *    independent date-bucket pages from ORGII's cache so a busy Today bucket
 *    cannot hide Yesterday.
 */
import {
  type ImportedHistorySource,
  getImportedHistorySourceByListCategory,
  getImportedHistorySourceBySessionId,
  isImportedHistoryListCategory,
  isImportedHistorySourceSession,
} from "@src/api/tauri/externalHistory";
import {
  type ExternalHistorySidebarResponse,
  type ExternalHistorySidebarSourceRequest,
  type SessionFilter,
  type SessionListResponse,
  externalHistorySidebarList,
  sessionAggregateList,
  toFrontendSessions,
} from "@src/api/tauri/session";
import { createLogger } from "@src/hooks/logger";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import {
  SESSION_DATE_BUCKET_KEYS,
  getSessionDateBucket,
  getSessionDateBucketRanges,
} from "@src/util/session/sessionDateBuckets";
import { getRustAgentType } from "@src/util/session/sessionDispatch";
import { isPrimarySessionListSession } from "@src/util/session/sessionVisibility";

import { DEFAULT_SESSION_ORG_ID } from "../creatorStateAtom";
import {
  dataSourceConfigAtom,
  externalSessionsEnabledAtom,
  isSourceDisabled,
} from "../dataSourceConfigAtom";
import {
  sessionErrorAtom,
  sessionFlatListLastLoadedBySignatureAtom,
  sessionLastLoadedAtom,
  sessionLoadingAtom,
  sessionsAtom,
} from "./atoms";
import { mergeGuestImportedSessions } from "./guestImportRegistry";
import {
  type CategoryPaginationState,
  type DateBucketPaginationMap,
  type NativeSidebarPageCursor,
  SESSION_LIST_CATEGORIES,
  SESSION_SIDEBAR_PAGE_SIZE,
  type SessionListCategory,
  type SessionPaginationMap,
  type SessionPaginationScope,
  categoryCanLoadInScope,
  emptyDateBucketPagination,
  parseSessionPaginationScopeKey,
  resetPaginationState,
  scopedSessionPaginationAtom,
  sessionPaginationAtom,
  sessionRosterGenerationAtom,
} from "./paginationAtoms";
import { persistSessions } from "./persistence";
import { normalizeSidebarDiscoveryOrgIds } from "./sidebarDiscoveryAtoms";
import { invalidateSidebarDiscovery } from "./sidebarDiscoveryLoaders";
import type { Session, SessionStatus } from "./types";

const log = createLogger("SessionAtom");

const getStore = () => getInstrumentedStore();
const BULK_CACHE_DURATION_MS = 5 * 60 * 1000;
const DEFAULT_FLAT_LIST_PAGE_SIZE = 200;
const exactSessionBatchLoadsByStore = new WeakMap<
  object,
  Map<string, Promise<Session[]>>
>();

function exactSessionBatchLoadsForStore(
  store: object
): Map<string, Promise<Session[]>> {
  let loads = exactSessionBatchLoadsByStore.get(store);
  if (!loads) {
    loads = new Map();
    exactSessionBatchLoadsByStore.set(store, loads);
  }
  return loads;
}

interface LoadSessionsOptions {
  repoPath?: string;
  orgId?: string;
  projectSlug?: string;
  workItemId?: string;
  status?: SessionStatus;
  limit?: number;
  offset?: number;
  forceRefresh?: boolean;
}

function loadSessionsCacheSignature(options?: LoadSessionsOptions): string {
  return [
    options?.repoPath ?? "",
    options?.orgId ?? "",
    options?.projectSlug ?? "",
    options?.workItemId ?? "",
    options?.status ?? "",
    options?.limit ?? "",
    options?.offset ?? "",
  ].join("\u001f");
}

function mergeSessions(
  prev: readonly Session[],
  incoming: readonly Session[]
): Session[] {
  if (incoming.length === 0) return prev.slice();
  const incomingMap = new Map(
    incoming.map((session) => [session.session_id, session])
  );
  const merged: Session[] = prev.map(
    (session) => incomingMap.get(session.session_id) ?? session
  );
  const seen = new Set(merged.map((session) => session.session_id));
  for (const session of incoming) {
    if (!seen.has(session.session_id)) {
      merged.push(session);
      seen.add(session.session_id);
    }
  }
  merged.sort((sessionA, sessionB) =>
    (sessionB.updated_at || "").localeCompare(sessionA.updated_at || "")
  );
  return merged;
}

function replaceImportedFirstPage(
  prev: readonly Session[],
  incoming: readonly Session[],
  shouldReplace: (session: Session) => boolean
): Session[] {
  const retained = prev.filter((session) => !shouldReplace(session));
  return mergeSessions(retained, incoming);
}

function replaceExternalHistorySourceFirstPage(
  prev: readonly Session[],
  incoming: readonly Session[],
  source: ImportedHistorySource,
  preserveChildren = true
): Session[] {
  return replaceImportedFirstPage(
    prev,
    incoming,
    (session) =>
      (!preserveChildren || !session.parentSessionId) &&
      isImportedHistorySourceSession(session.session_id, source)
  );
}

function setPaginationFor(
  category: SessionListCategory,
  patch: Partial<SessionPaginationMap[SessionListCategory]>
) {
  const store = getStore();
  store.set(sessionPaginationAtom, (prev) => ({
    ...prev,
    [category]: { ...prev[category], ...patch },
  }));
}

function isCurrentRosterGeneration(generation: number): boolean {
  return getStore().get(sessionRosterGenerationAtom) === generation;
}

function isCurrentCategoryRequest(
  category: SessionListCategory,
  generation: number,
  requestToken: number
): boolean {
  const store = getStore();
  const state = store.get(sessionPaginationAtom)[category];
  return (
    store.get(sessionRosterGenerationAtom) === generation &&
    state.generation === generation &&
    state.requestToken === requestToken
  );
}

function invalidateSessionRosterLoads(): number {
  const store = getStore();
  const generation = store.get(sessionRosterGenerationAtom) + 1;
  store.set(sessionRosterGenerationAtom, generation);
  store.set(sessionPaginationAtom, resetPaginationState(generation));
  store.set(scopedSessionPaginationAtom, {});
  invalidateSidebarDiscovery();
  return generation;
}

async function loadImportedHistorySourcePage(
  source: ImportedHistorySource,
  currentBuckets: DateBucketPaginationMap | undefined,
  pageSize: number,
  scope?: SessionPaginationScope
): Promise<FetchPageResult> {
  const pages = await loadImportedHistorySourcePages(
    [{ source, currentBuckets, scope }],
    pageSize
  );
  return (
    pages.get(source.sourceId) ?? {
      sessions: [],
      hasMore: false,
      dateBuckets: currentBuckets ?? emptyDateBucketPagination(),
    }
  );
}

interface ImportedHistoryPageInput {
  source: ImportedHistorySource;
  currentBuckets?: DateBucketPaginationMap;
  scope?: SessionPaginationScope;
}

function buildImportedHistorySourceRequest(
  source: ImportedHistorySource,
  currentBuckets: DateBucketPaginationMap | undefined,
  pageSize: number,
  scope?: SessionPaginationScope
): ExternalHistorySidebarSourceRequest | null {
  if (
    scope &&
    !normalizeSidebarDiscoveryOrgIds(scope.orgIds).includes(
      DEFAULT_SESSION_ORG_ID
    )
  ) {
    return null;
  }
  const ranges = getSessionDateBucketRanges();
  const buckets = ranges
    .filter(({ bucket }) => scope?.kind !== "time" || scope.bucket === bucket)
    .filter(({ bucket }) => !currentBuckets || currentBuckets[bucket].hasMore)
    .map(({ bucket, startMs, endMs }) => ({
      bucket,
      startMs,
      endMs,
      limit: pageSize,
      offset: currentBuckets?.[bucket].cursor
        ? 0
        : (currentBuckets?.[bucket].loaded ?? 0),
      before: currentBuckets?.[bucket].cursor,
    }));
  if (buckets.length === 0) return null;
  return {
    source: source.sourceId,
    repoPath:
      scope?.kind === "workspace" ? (scope.repoPath ?? undefined) : undefined,
    missingRepoPath:
      scope?.kind === "workspace" && scope.repoPath === null ? true : undefined,
    buckets,
  };
}

function importedHistoryPageResult(
  source: ImportedHistorySource,
  currentBuckets: DateBucketPaginationMap | undefined,
  response: ExternalHistorySidebarResponse
): FetchPageResult {
  const dateBuckets = mergeDateBucketPagination(currentBuckets, response);
  const sessions = response.buckets.flatMap((page) =>
    page.sessions.map((row): Session => {
      const name = row.name.trim() || row.sessionId;
      return {
        session_id: row.sessionId,
        name,
        status: row.status ?? "completed",
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        created_time: row.createdAt,
        updated_time: row.updatedAt,
        category: "external_history",
        readOnly: true,
        is_active: row.isActive ?? false,
        background: false,
        repoPath: row.repoPath,
        repoRootPath: row.repoRootPath,
        repoRemoteUrls: row.repoRemoteUrls,
        storagePath: row.storagePath,
        agentIconId: source.iconId,
        agentDisplayName: source.displayName,
        model: row.model,
        totalTokens: row.totalTokens,
        filesChanged: row.filesChanged,
        linesAdded: row.linesAdded,
        linesRemoved: row.linesRemoved,
        touchedFiles: row.touchedFiles,
      };
    })
  );
  return {
    sessions,
    hasMore: SESSION_DATE_BUCKET_KEYS.some(
      (bucket) => dateBuckets[bucket].hasMore
    ),
    dateBuckets,
  };
}

async function loadImportedHistorySourcePages(
  inputs: readonly ImportedHistoryPageInput[],
  pageSize: number
): Promise<Map<string, FetchPageResult>> {
  const results = new Map<string, FetchPageResult>();
  const pending = inputs.flatMap(({ source, currentBuckets, scope }) => {
    const request = buildImportedHistorySourceRequest(
      source,
      currentBuckets,
      pageSize,
      scope
    );
    if (!request) {
      results.set(source.sourceId, {
        sessions: [],
        hasMore: false,
        dateBuckets: currentBuckets ?? emptyDateBucketPagination(),
      });
      return [];
    }
    return [{ source, currentBuckets, request }];
  });

  if (pending.length === 0) return results;

  const response = await externalHistorySidebarList({
    requests: pending.map(({ request }) => request),
  });
  const responseBySource = new Map(
    response.sources.map((sourceResponse) => [
      sourceResponse.source,
      sourceResponse,
    ])
  );
  for (const { source, currentBuckets } of pending) {
    const sourceResponse = responseBySource.get(source.sourceId);
    if (!sourceResponse) {
      throw new Error(
        `External history sidebar response omitted ${source.sourceId}`
      );
    }
    results.set(
      source.sourceId,
      importedHistoryPageResult(source, currentBuckets, sourceResponse)
    );
  }
  return results;
}

function mergeDateBucketPagination(
  current: DateBucketPaginationMap | undefined,
  response: ExternalHistorySidebarResponse
): DateBucketPaginationMap {
  const next = { ...(current ?? emptyDateBucketPagination()) };
  for (const page of response.buckets) {
    const previous = next[page.bucket];
    next[page.bucket] = {
      loaded: previous.loaded + page.sessions.length,
      hasMore: page.hasMore,
      cursor: page.nextCursor ?? previous.cursor,
    };
  }
  return next;
}

export const loadSessions = async (options?: LoadSessionsOptions) => {
  const store = getStore();
  const { forceRefresh = false } = options || {};
  const cacheSignature = loadSessionsCacheSignature(options);

  const lastLoaded = store.get(sessionFlatListLastLoadedBySignatureAtom)[
    cacheSignature
  ];
  const now = Date.now();

  if (
    !forceRefresh &&
    lastLoaded &&
    now - lastLoaded < BULK_CACHE_DURATION_MS
  ) {
    return;
  }

  store.set(sessionLoadingAtom, true);
  store.set(sessionErrorAtom, null);

  try {
    const filter: SessionFilter | undefined =
      options?.repoPath ||
      options?.orgId ||
      options?.projectSlug ||
      options?.workItemId ||
      options?.status ||
      options?.limit ||
      options?.offset
        ? {
            repoPath: options?.repoPath,
            orgId: options?.orgId,
            projectSlug: options?.projectSlug,
            workItemId: options?.workItemId,
            status: options?.status,
            limit: options?.limit,
            offset: options?.offset,
          }
        : undefined;

    const disabledSources = Object.entries(store.get(dataSourceConfigAtom))
      .filter(([, cfg]) => cfg?.enabled === false)
      .map(([sourceId]) => sourceId);

    const response = await sessionAggregateList({
      ...filter,
      limit: filter?.limit ?? DEFAULT_FLAT_LIST_PAGE_SIZE,
      includeExternalHistory: store.get(externalSessionsEnabledAtom),
      sortBy: filter?.sortBy ?? "updated_at",
      sortOrder: filter?.sortOrder ?? "desc",
      disabledExternalHistorySources:
        disabledSources.length > 0 ? disabledSources : undefined,
    });

    const fetched: Session[] = mergeGuestImportedSessions(
      toFrontendSessions((response as SessionListResponse).sessions)
    );

    fetched.sort((sessionA, sessionB) =>
      (sessionB.updated_at || "").localeCompare(sessionA.updated_at || "")
    );

    store.set(sessionsAtom, fetched);
    persistSessions(fetched);
    store.set(sessionFlatListLastLoadedBySignatureAtom, (prev) => ({
      ...prev,
      [cacheSignature]: now,
    }));
  } catch (error) {
    log.error("[SessionAtom] Failed to load sessions:", error);
    store.set(
      sessionErrorAtom,
      error instanceof Error ? error.message : "Failed to load sessions"
    );
  } finally {
    store.set(sessionLoadingAtom, false);
  }
};

interface FetchPageResult {
  sessions: Session[];
  hasMore: boolean;
  dateBuckets?: DateBucketPaginationMap;
  cursor?: NativeSidebarPageCursor;
}

async function fetchAggregatePage(
  wireCategory:
    | "cli"
    | "sde"
    | "agent_org"
    | "os"
    | "wingman"
    | "custom"
    | "human",
  offset: number,
  pageSize: number,
  scope?: SessionPaginationScope,
  cursor?: NativeSidebarPageCursor
): Promise<FetchPageResult> {
  const dateRange =
    scope?.kind === "time"
      ? getSessionDateBucketRanges().find(
          ({ bucket }) => bucket === scope.bucket
        )
      : undefined;
  const response = await sessionAggregateList({
    category: wireCategory,
    orgIds: [
      ...normalizeSidebarDiscoveryOrgIds(
        scope?.orgIds ?? [DEFAULT_SESSION_ORG_ID]
      ),
    ],
    repoPath:
      scope?.kind === "workspace" ? (scope.repoPath ?? undefined) : undefined,
    repoPathExact:
      scope?.kind === "workspace" && scope.repoPath !== null ? true : undefined,
    missingRepoPath:
      scope?.kind === "workspace" && scope.repoPath === null ? true : undefined,
    updatedAfterMs: dateRange?.startMs,
    updatedBeforeMs: dateRange?.endMs,
    includeExternalHistory: false,
    limit: pageSize + 1,
    offset: cursor ? 0 : offset,
    beforeUpdatedAt: cursor?.updatedAt,
    beforeSessionId: cursor?.sessionId,
    sortBy: "updated_at",
    sortOrder: "desc",
  });
  const primarySessions = toFrontendSessions(response.sessions)
    .filter(isPrimarySessionListSession)
    .slice(0, pageSize);
  return {
    sessions: primarySessions,
    hasMore: response.sessions.length > pageSize,
    cursor: primarySessions.at(-1)
      ? {
          updatedAt: primarySessions.at(-1)!.updated_at,
          sessionId: primarySessions.at(-1)!.session_id,
        }
      : cursor,
  };
}

async function loadCategoryPage(
  category: SessionListCategory,
  offset: number,
  pageSize: number,
  dateBuckets?: DateBucketPaginationMap,
  scope?: SessionPaginationScope,
  cursor?: NativeSidebarPageCursor
): Promise<FetchPageResult> {
  if (isImportedHistoryListCategory(category)) {
    const source = getImportedHistorySourceByListCategory(category);
    if (!source) return { sessions: [], hasMore: false };
    return loadImportedHistorySourcePage(source, dateBuckets, pageSize, scope);
  }

  switch (category) {
    case "cli_agent":
      return fetchAggregatePage("cli", offset, pageSize, scope, cursor);
    case "rust_agent:sde":
      return fetchAggregatePage("sde", offset, pageSize, scope, cursor);
    case "rust_agent:agent_org":
      return fetchAggregatePage("agent_org", offset, pageSize, scope, cursor);
    case "rust_agent:os":
      return fetchAggregatePage("os", offset, pageSize, scope, cursor);
    case "rust_agent:wingman":
      return fetchAggregatePage("wingman", offset, pageSize, scope, cursor);
    case "rust_agent:custom":
      return fetchAggregatePage("custom", offset, pageSize, scope, cursor);
    case "human_session":
      return fetchAggregatePage("human", offset, pageSize, scope, cursor);
  }
}

function replaceFirstPageForCategory(
  category: SessionListCategory,
  prev: readonly Session[],
  incoming: readonly Session[],
  preserveImportedChildren = true
): Session[] {
  if (isImportedHistoryListCategory(category)) {
    const source = getImportedHistorySourceByListCategory(category);
    return source
      ? replaceExternalHistorySourceFirstPage(
          prev,
          incoming,
          source,
          preserveImportedChildren
        )
      : mergeSessions(prev, incoming);
  }
  return mergeSessions(prev, incoming);
}

interface SidebarLoadOptions {
  pageSize?: number;
  forceRefresh?: boolean;
  generation?: number;
}

const performSidebarSessionLoad = async (options?: SidebarLoadOptions) => {
  const store = getStore();
  const pageSize = options?.pageSize ?? SESSION_SIDEBAR_PAGE_SIZE;
  const { forceRefresh = false } = options ?? {};
  const generation =
    options?.generation ?? store.get(sessionRosterGenerationAtom);

  const lastLoaded = store.get(sessionLastLoadedAtom);
  const now = Date.now();

  if (
    !forceRefresh &&
    lastLoaded &&
    now - lastLoaded < BULK_CACHE_DURATION_MS
  ) {
    return;
  }

  store.set(sessionLoadingAtom, true);
  store.set(sessionErrorAtom, null);
  store.set(sessionPaginationAtom, resetPaginationState(generation));
  store.set(scopedSessionPaginationAtom, {});

  // Sources the user has disabled in the Data Sources panel must not load;
  // the master external-sessions switch disables all of them at once.
  const dataSourceConfig = store.get(dataSourceConfigAtom);
  const externalSessionsEnabled = store.get(externalSessionsEnabledAtom);
  const isCategoryDisabled = (category: string): boolean => {
    if (!isImportedHistoryListCategory(category)) return false;
    if (!externalSessionsEnabled) return true;
    const source = getImportedHistorySourceByListCategory(category);
    return source ? isSourceDisabled(dataSourceConfig, source.sourceId) : false;
  };

  const requestTokens = new Map<SessionListCategory, number>();
  for (const category of SESSION_LIST_CATEGORIES) {
    const requestToken =
      (store.get(sessionPaginationAtom)[category].requestToken ?? 0) + 1;
    requestTokens.set(category, requestToken);
    setPaginationFor(category, {
      generation,
      requestToken,
      loading: true,
    });
  }

  const enabledCategories = SESSION_LIST_CATEGORIES.filter((category) => {
    if (!isCategoryDisabled(category)) return true;
    store.set(sessionsAtom, (prev) =>
      replaceFirstPageForCategory(category, prev, [], false)
    );
    setPaginationFor(category, {
      generation,
      requestToken: requestTokens.get(category),
      loaded: 0,
      hasMore: false,
      loading: false,
    });
    return false;
  });

  const applyInitialPage = (
    category: SessionListCategory,
    { sessions, hasMore, dateBuckets, cursor }: FetchPageResult
  ) => {
    const requestToken = requestTokens.get(category);
    if (
      requestToken === undefined ||
      !isCurrentCategoryRequest(category, generation, requestToken)
    ) {
      return;
    }
    store.set(sessionsAtom, (prev) =>
      replaceFirstPageForCategory(category, prev, sessions)
    );
    setPaginationFor(category, {
      loaded: sessions.length,
      hasMore,
      loading: false,
      generation,
      requestToken,
      loadedSessionIds: sessions.map((session) => session.session_id),
      dateBuckets,
      cursor,
    });
  };

  const nativeTasks = enabledCategories
    .filter((category) => !isImportedHistoryListCategory(category))
    .map(async (category) => {
      try {
        const result = await loadCategoryPage(
          category,
          0,
          pageSize,
          undefined,
          {
            kind: "category",
            category,
            orgIds: [DEFAULT_SESSION_ORG_ID],
          }
        );
        applyInitialPage(category, result);
      } catch (error) {
        log.warn(`[SessionAtom] ${category} initial page failed:`, error);
        const requestToken = requestTokens.get(category);
        if (
          requestToken !== undefined &&
          isCurrentCategoryRequest(category, generation, requestToken)
        ) {
          setPaginationFor(category, { loading: false });
        }
      }
    });

  const importedCategories = enabledCategories.flatMap((category) => {
    if (!isImportedHistoryListCategory(category)) return [];
    const source = getImportedHistorySourceByListCategory(category);
    return source ? [{ category, source }] : [];
  });
  const importedTask = (async () => {
    if (importedCategories.length === 0) return;
    try {
      const pages = await loadImportedHistorySourcePages(
        importedCategories.map(({ source }) => ({ source })),
        pageSize
      );
      for (const { category, source } of importedCategories) {
        const page = pages.get(source.sourceId);
        if (!page) {
          throw new Error(
            `External history sidebar page missing ${source.sourceId}`
          );
        }
        applyInitialPage(category, page);
      }
    } catch (error) {
      log.warn("[SessionAtom] external history initial pages failed:", error);
      for (const { category } of importedCategories) {
        const requestToken = requestTokens.get(category);
        if (
          requestToken !== undefined &&
          isCurrentCategoryRequest(category, generation, requestToken)
        ) {
          setPaginationFor(category, { loading: false });
        }
      }
    }
  })();

  await Promise.allSettled([...nativeTasks, importedTask]);

  if (isCurrentRosterGeneration(generation)) {
    const merged = store.get(sessionsAtom);
    persistSessions(merged);
    store.set(sessionLastLoadedAtom, now);
    store.set(sessionLoadingAtom, false);
  }
};

function mergeSidebarLoadOptions(
  current: SidebarLoadOptions | null,
  requested: SidebarLoadOptions
): SidebarLoadOptions {
  return {
    pageSize: Math.max(
      current?.pageSize ?? SESSION_SIDEBAR_PAGE_SIZE,
      requested.pageSize ?? SESSION_SIDEBAR_PAGE_SIZE
    ),
    forceRefresh:
      (current?.forceRefresh ?? false) || (requested.forceRefresh ?? false),
    generation: Math.max(current?.generation ?? 0, requested.generation ?? 0),
  };
}

function sidebarLoadCovers(
  active: SidebarLoadOptions | null,
  requested: SidebarLoadOptions
): boolean {
  if (!active) return false;
  const activePageSize = active.pageSize ?? SESSION_SIDEBAR_PAGE_SIZE;
  const requestedPageSize = requested.pageSize ?? SESSION_SIDEBAR_PAGE_SIZE;
  return (
    active.generation === requested.generation &&
    activePageSize >= requestedPageSize &&
    ((active.forceRefresh ?? false) || !(requested.forceRefresh ?? false))
  );
}

/**
 * Build a single-flight coordinator around the sidebar read. Kept as a small
 * injectable unit so queue coverage, escalation, and failure recovery can be
 * tested without exercising every session provider.
 */
function createSidebarLoadCoordinator(
  load: (options?: SidebarLoadOptions) => Promise<void>
): (options?: SidebarLoadOptions) => Promise<void> {
  let inFlight: Promise<void> | null = null;
  let active: SidebarLoadOptions | null = null;
  let pending: SidebarLoadOptions | null = null;

  return (options: SidebarLoadOptions = {}): Promise<void> => {
    const requested = mergeSidebarLoadOptions(null, options);
    if (inFlight && sidebarLoadCovers(active, requested)) {
      return inFlight;
    }
    pending = mergeSidebarLoadOptions(pending, requested);
    if (inFlight) return inFlight;

    const run = async () => {
      while (pending) {
        const next = pending;
        pending = null;
        active = next;
        await load(next);
      }
    };
    inFlight = run().finally(() => {
      active = null;
      inFlight = null;
    });
    return inFlight;
  };
}

/**
 * One process-wide session-roster loader. Overlapping mounts/refreshes join the
 * active read; a stronger request (forced or larger page) is merged into one
 * follow-up pass instead of starting a parallel category fan-out.
 */
const coordinatedSessionRosterLoad = createSidebarLoadCoordinator(
  performSidebarSessionLoad
);

export const loadSessionRoster = (
  options: SidebarLoadOptions = {}
): Promise<void> => {
  const generation = options.forceRefresh
    ? invalidateSessionRosterLoads()
    : getStore().get(sessionRosterGenerationAtom);
  return coordinatedSessionRosterLoad({ ...options, generation });
};

/**
 * Compatibility alias for callers outside the roster surfaces. New Sidebar
 * and Kanban code should use `loadSessionRoster` so ownership is unambiguous.
 */
export const loadSidebarSessions = loadSessionRoster;

/**
 * Hydrate canonical session rows by exact id.
 *
 * Normal sidebar loading is intentionally paginated per source/date bucket.
 * Deep links and cloud-scoped My Conversations can target much older rows, so
 * walking pages would be slow and nondeterministic. The aggregate API resolves
 * the exact ids in one bounded batch and merges only authoritative rows.
 */
export function loadSidebarSessionsByIds(
  sessionIds: readonly string[]
): Promise<Session[]> {
  const normalizedSessionIds = [
    ...new Set(sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)),
  ];
  if (normalizedSessionIds.length === 0) return Promise.resolve([]);

  const store = getStore();
  const exactSessionBatchLoads = exactSessionBatchLoadsForStore(store);
  // React effects and deep-link reveals can converge on the same exact rows.
  // Share that batch while it is active; entries are removed on settlement so
  // this coordinator cannot grow over the app lifetime.
  const requestKey = JSON.stringify([...normalizedSessionIds].sort());
  const existing = exactSessionBatchLoads.get(requestKey);
  if (existing) return existing;

  const request = (async (): Promise<Session[]> => {
    const response = await sessionAggregateList({
      sessionIds: normalizedSessionIds,
      includeExternalHistory: store.get(externalSessionsEnabledAtom),
      limit: normalizedSessionIds.length,
    });
    const requestedIds = new Set(normalizedSessionIds);
    const loaded = toFrontendSessions(response.sessions).filter((candidate) =>
      requestedIds.has(candidate.session_id)
    );
    if (loaded.length === 0) return [];

    store.set(sessionsAtom, (previous) => mergeSessions(previous, loaded));
    persistSessions(store.get(sessionsAtom));
    return loaded;
  })();
  const trackedRequest = request.finally(() => {
    if (exactSessionBatchLoads.get(requestKey) === trackedRequest) {
      exactSessionBatchLoads.delete(requestKey);
    }
  });
  exactSessionBatchLoads.set(requestKey, trackedRequest);
  return trackedRequest;
}

export const loadSidebarSessionById = async (
  sessionId: string
): Promise<Session | null> => {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return null;

  // Do not return an existing atom row before resolving the canonical record.
  // Transcript activation can insert a lightweight row first; imported
  // subagent rows in particular need the provider cache's parentSessionId so
  // the sidebar can place them beneath the root session deterministically.
  const loaded = await loadSidebarSessionsByIds([normalizedSessionId]);
  return (
    loaded.find((session) => session.session_id === normalizedSessionId) ?? null
  );
};

function listCategoryForSession(session: Session): SessionListCategory | null {
  const importedSource = getImportedHistorySourceBySessionId(
    session.session_id
  );
  if (importedSource) return importedSource.listCategory;
  if (session.agentOrgId) return "rust_agent:agent_org";
  if (session.category === "cli_agent") return "cli_agent";
  if (session.category === "human_session") return "human_session";
  if (session.category !== "rust_agent") return null;
  switch (getRustAgentType(session.session_id)) {
    case "sde":
      return "rust_agent:sde";
    case "os":
      return "rust_agent:os";
    case "wingman":
      return "rust_agent:wingman";
    case "custom":
      return "rust_agent:custom";
  }
}

function normalizedWorkspacePath(path: string | undefined): string | null {
  const normalized = path?.trim().replace(/\/+$/, "") ?? "";
  return normalized || null;
}

function sessionMatchesPaginationScope(
  session: Session,
  scope: SessionPaginationScope
): boolean {
  const orgIds = normalizeSidebarDiscoveryOrgIds(scope.orgIds);
  const sessionOrgId = session.orgId?.trim() || DEFAULT_SESSION_ORG_ID;
  if (!orgIds.includes(sessionOrgId)) return false;
  if (scope.kind === "category") {
    return listCategoryForSession(session) === scope.category;
  }
  if (scope.kind === "time") {
    return getSessionDateBucket(session) === scope.bucket;
  }
  return normalizedWorkspacePath(session.repoPath) === scope.repoPath;
}

function initialScopedCategoryState(
  category: SessionListCategory,
  scope: SessionPaginationScope,
  globalState: CategoryPaginationState,
  sessions: readonly Session[]
): CategoryPaginationState {
  const normalizedOrgIds = normalizeSidebarDiscoveryOrgIds(scope.orgIds);
  const canReusePersonalPrefix =
    normalizedOrgIds.length === 1 &&
    normalizedOrgIds[0] === DEFAULT_SESSION_ORG_ID;
  if (!canReusePersonalPrefix) {
    return {
      loaded: 0,
      hasMore: true,
      loading: false,
      loadedSessionIds: [],
      ...(isImportedHistoryListCategory(category)
        ? { dateBuckets: emptyDateBucketPagination() }
        : {}),
    };
  }
  const globallyConsumedIds = new Set(globalState.loadedSessionIds ?? []);
  const matchingSessions = sessions.filter(
    (session) =>
      globallyConsumedIds.has(session.session_id) &&
      listCategoryForSession(session) === category &&
      sessionMatchesPaginationScope(session, scope)
  );
  if (!isImportedHistoryListCategory(category)) {
    return {
      loaded: matchingSessions.length,
      hasMore: globalState.hasMore,
      loading: false,
      loadedSessionIds: matchingSessions.map((session) => session.session_id),
      cursor: globalState.cursor,
    };
  }

  const dateBuckets = { ...emptyDateBucketPagination() };
  for (const bucket of SESSION_DATE_BUCKET_KEYS) {
    const bucketInScope = scope.kind !== "time" || scope.bucket === bucket;
    dateBuckets[bucket] = {
      loaded: matchingSessions.filter(
        (session) => getSessionDateBucket(session) === bucket
      ).length,
      hasMore:
        bucketInScope && (globalState.dateBuckets?.[bucket].hasMore ?? false),
      cursor: bucketInScope
        ? globalState.dateBuckets?.[bucket].cursor
        : undefined,
    };
  }
  return {
    loaded: matchingSessions.length,
    hasMore: SESSION_DATE_BUCKET_KEYS.some(
      (bucket) => dateBuckets[bucket].hasMore
    ),
    loading: false,
    loadedSessionIds: matchingSessions.map((session) => session.session_id),
    dateBuckets,
  };
}

/**
 * Load one bounded backend page for a visible By Time / By Workspace group.
 *
 * Each source keeps an offset within this exact scope. A request for Older or
 * `/repo-a` therefore cannot consume rows belonging to Today or `/repo-b`.
 * The merged session atom still deduplicates rows already discovered by the
 * global roster or another view.
 */
export const loadMoreSessionScope = async (
  scopeKey: string,
  pageSize: number = SESSION_SIDEBAR_PAGE_SIZE
) => {
  const scope = parseSessionPaginationScopeKey(scopeKey);
  if (!scope) return;

  const store = getStore();
  const generation = store.get(sessionRosterGenerationAtom);
  const existingScopeState = store.get(scopedSessionPaginationAtom)[scopeKey];
  if (existingScopeState?.loading) return;
  const pagination = store.get(sessionPaginationAtom);
  const sessions = store.get(sessionsAtom);
  const categories = SESSION_LIST_CATEGORIES.filter((category) =>
    categoryCanLoadInScope(
      category,
      scope,
      pagination[category],
      existingScopeState?.categories[category]
    )
  );
  if (categories.length === 0) return;
  const requestToken = (existingScopeState?.requestToken ?? 0) + 1;

  const initialCategories = { ...existingScopeState?.categories };
  for (const category of categories) {
    const current =
      initialCategories[category] ??
      initialScopedCategoryState(
        category,
        scope,
        pagination[category],
        sessions
      );
    initialCategories[category] = {
      ...current,
      generation,
      requestToken,
      loading: true,
    };
  }
  store.set(scopedSessionPaginationAtom, (previous) => ({
    ...previous,
    [scopeKey]: {
      scope,
      loading: true,
      generation,
      requestToken,
      categories: initialCategories,
    },
  }));

  const results = await Promise.allSettled(
    categories.map(async (category) => {
      const current = initialCategories[category]!;
      const result = await loadCategoryPage(
        category,
        current.loaded,
        pageSize,
        current.dateBuckets,
        scope,
        current.cursor
      );
      return { category, current, result };
    })
  );

  const latestScopeState = store.get(scopedSessionPaginationAtom)[scopeKey];
  if (
    store.get(sessionRosterGenerationAtom) !== generation ||
    latestScopeState?.generation !== generation ||
    latestScopeState.requestToken !== requestToken
  ) {
    return;
  }

  let loadedAny = false;
  const nextCategories = { ...initialCategories };
  for (const result of results) {
    if (result.status === "rejected") {
      log.warn("[SessionAtom] scoped sidebar page failed:", result.reason);
      continue;
    }
    const { category, current, result: page } = result.value;
    const primarySessions = page.sessions.filter(isPrimarySessionListSession);
    if (primarySessions.length > 0) {
      loadedAny = true;
      store.set(sessionsAtom, (previous) =>
        mergeSessions(previous, primarySessions)
      );
    }
    nextCategories[category] = {
      loaded: current.loaded + page.sessions.length,
      hasMore: page.hasMore,
      loading: false,
      loadedSessionIds: [
        ...(current.loadedSessionIds ?? []),
        ...page.sessions.map((session) => session.session_id),
      ],
      dateBuckets: page.dateBuckets,
      cursor: page.cursor ?? current.cursor,
    };
  }
  for (const category of categories) {
    const state = nextCategories[category];
    if (state?.loading) {
      nextCategories[category] = { ...state, loading: false };
    }
  }
  store.set(scopedSessionPaginationAtom, (previous) => ({
    ...previous,
    [scopeKey]: {
      scope,
      loading: false,
      generation,
      requestToken,
      categories: nextCategories,
    },
  }));
  if (loadedAny) {
    persistSessions(store.get(sessionsAtom));
  }
};

export const loadMoreCategory = async (
  category: SessionListCategory,
  pageSize: number = SESSION_SIDEBAR_PAGE_SIZE
) => {
  const store = getStore();
  const generation = store.get(sessionRosterGenerationAtom);
  const current = store.get(sessionPaginationAtom)[category];
  if (current.loading || !current.hasMore) return;

  const requestToken = (current.requestToken ?? 0) + 1;
  setPaginationFor(category, {
    generation,
    requestToken,
    loading: true,
  });

  try {
    const { sessions, hasMore, dateBuckets } = await loadCategoryPage(
      category,
      current.loaded,
      pageSize,
      current.dateBuckets,
      undefined,
      current.cursor
    );
    const primarySessions = sessions.filter(isPrimarySessionListSession);
    if (!isCurrentCategoryRequest(category, generation, requestToken)) return;
    store.set(sessionsAtom, (prev) => mergeSessions(prev, primarySessions));
    setPaginationFor(category, {
      loaded: current.loaded + sessions.length,
      hasMore,
      loading: false,
      generation,
      requestToken,
      loadedSessionIds: [
        ...(current.loadedSessionIds ?? []),
        ...sessions.map((session) => session.session_id),
      ],
      dateBuckets,
      cursor:
        sessions.length > 0
          ? {
              updatedAt: sessions[sessions.length - 1]!.updated_at,
              sessionId: sessions[sessions.length - 1]!.session_id,
            }
          : current.cursor,
    });
    persistSessions(store.get(sessionsAtom));
  } catch (error) {
    log.warn(`[SessionAtom] loadMoreCategory(${category}) failed:`, error);
    if (isCurrentCategoryRequest(category, generation, requestToken)) {
      setPaginationFor(category, { loading: false });
    }
  }
};

export const __TESTS_ONLY = {
  createSidebarLoadCoordinator,
  mergeSessions,
  replaceExternalHistorySourceFirstPage,
};
