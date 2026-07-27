/**
 * Independent compact discovery queries for the workstation sidebar.
 *
 * Search, pinned rows, and workspace facets must find older sessions without
 * advancing the ordinary category/date/workspace cursors. Their results
 * therefore live only in the matching discovery atoms and are unioned at the
 * rendering boundary.
 */
import {
  sessionAggregateList,
  sessionWorkspaceFacets,
  toFrontendSessions,
} from "@src/api/tauri/session";
import { createLogger } from "@src/hooks/logger";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";
import { isPrimarySessionListSession } from "@src/util/session/sessionVisibility";

import {
  dataSourceConfigAtom,
  externalSessionsEnabledAtom,
} from "../dataSourceConfigAtom";
import {
  SIDEBAR_DISCOVERY_PAGE_SIZE,
  SIDEBAR_SEARCH_RESULT_LIMIT,
  normalizeSidebarDiscoveryOrgIds,
  sidebarDiscoveryGenerationAtom,
  sidebarPinnedPagesAtom,
  sidebarPinnedScopeKey,
  sidebarSearchQueryKey,
  sidebarSearchResultsAtom,
  sidebarWorkspaceFacetPagesAtom,
  sidebarWorkspaceFacetScopeKey,
} from "./sidebarDiscoveryAtoms";
import type { Session } from "./types";

const log = createLogger("SidebarSessionDiscovery");
const getStore = () => getInstrumentedStore();

/** Invalidate every compact discovery request before a roster/source reset. */
export function invalidateSidebarDiscovery(): number {
  const store = getStore();
  const generation = store.get(sidebarDiscoveryGenerationAtom) + 1;
  store.set(sidebarDiscoveryGenerationAtom, generation);
  store.set(sidebarSearchResultsAtom, {
    queryKey: "",
    generation,
    requestToken: 0,
    loading: false,
    sessions: [],
  });
  store.set(sidebarPinnedPagesAtom, {});
  store.set(sidebarWorkspaceFacetPagesAtom, {});
  return generation;
}

interface SidebarDiscoveryPolicy {
  includeExternalHistory: boolean;
  disabledExternalHistorySources: string[];
}

export interface SidebarSearchRequest {
  query: string;
  orgIds: readonly string[];
  includeExternal: boolean;
}

export interface SidebarDiscoveryPageRequest {
  orgIds: readonly string[];
  includeExternal: boolean;
  pageSize?: number;
}

function sidebarDiscoveryPolicy(
  requestedIncludeExternal: boolean
): SidebarDiscoveryPolicy {
  const store = getStore();
  const disabledExternalHistorySources = Object.entries(
    store.get(dataSourceConfigAtom)
  )
    .filter(([, config]) => config?.enabled === false)
    .map(([sourceId]) => sourceId)
    .sort();
  return {
    includeExternalHistory:
      requestedIncludeExternal && store.get(externalSessionsEnabledAtom),
    disabledExternalHistorySources,
  };
}

function mergeDiscoveredSessions(
  current: readonly Session[],
  page: readonly Session[]
): Session[] {
  const sessionsById = new Map(
    current.map((session) => [session.session_id, session] as const)
  );
  for (const session of page) sessionsById.set(session.session_id, session);
  return Array.from(sessionsById.values()).sort((left, right) =>
    (right.updated_at || "").localeCompare(left.updated_at || "")
  );
}

function currentSidebarSearchKey(request: SidebarSearchRequest): {
  queryKey: string;
  orgIds: readonly string[];
  policy: SidebarDiscoveryPolicy;
} {
  const orgIds = normalizeSidebarDiscoveryOrgIds(request.orgIds);
  const policy = sidebarDiscoveryPolicy(request.includeExternal);
  return {
    queryKey: sidebarSearchQueryKey({
      query: request.query,
      orgIds,
      ...policy,
    }),
    orgIds,
    policy,
  };
}

/**
 * Start a new visible search episode immediately.
 *
 * The React caller does this synchronously on every keystroke, before its
 * debounce timer starts, so a late response for the previous text or org
 * scope can never repaint the sidebar.
 */
export function beginSidebarSearchRequest(
  request: SidebarSearchRequest
): number {
  const store = getStore();
  const { queryKey } = currentSidebarSearchKey(request);
  const generation = store.get(sidebarDiscoveryGenerationAtom);
  const requestToken = store.get(sidebarSearchResultsAtom).requestToken + 1;
  store.set(sidebarSearchResultsAtom, {
    queryKey,
    generation,
    requestToken,
    loading: false,
    sessions: [],
  });
  return requestToken;
}

/**
 * Search the compact source tables, capped at 50 rows.
 *
 * Results intentionally live outside `sessionsAtom`: search must not advance
 * or contaminate any ordinary category/workspace/date cursor.
 */
export async function loadSidebarSearchResults(
  request: SidebarSearchRequest,
  requestToken: number
): Promise<void> {
  const store = getStore();
  const { queryKey, orgIds, policy } = currentSidebarSearchKey(request);
  if (!queryKey) return;
  const current = store.get(sidebarSearchResultsAtom);
  const generation = store.get(sidebarDiscoveryGenerationAtom);
  if (
    current.generation !== generation ||
    current.requestToken !== requestToken ||
    current.queryKey !== queryKey
  ) {
    return;
  }
  store.set(sidebarSearchResultsAtom, { ...current, loading: true });

  try {
    const response = await sessionAggregateList({
      textQuery: request.query.trim(),
      orgIds: [...orgIds],
      includeExternalHistory: policy.includeExternalHistory,
      disabledExternalHistorySources:
        policy.disabledExternalHistorySources.length > 0
          ? policy.disabledExternalHistorySources
          : undefined,
      limit: SIDEBAR_SEARCH_RESULT_LIMIT,
      offset: 0,
      sortBy: "updated_at",
      sortOrder: "desc",
    });
    const sessions = toFrontendSessions(response.sessions)
      .filter(isPrimarySessionListSession)
      .slice(0, SIDEBAR_SEARCH_RESULT_LIMIT);
    const latest = store.get(sidebarSearchResultsAtom);
    if (
      latest.generation !== generation ||
      store.get(sidebarDiscoveryGenerationAtom) !== generation ||
      latest.requestToken !== requestToken ||
      latest.queryKey !== queryKey
    ) {
      return;
    }
    store.set(sidebarSearchResultsAtom, {
      queryKey,
      generation,
      requestToken,
      loading: false,
      sessions,
    });
  } catch (error) {
    const latest = store.get(sidebarSearchResultsAtom);
    if (
      latest.generation === generation &&
      store.get(sidebarDiscoveryGenerationAtom) === generation &&
      latest.requestToken === requestToken &&
      latest.queryKey === queryKey
    ) {
      store.set(sidebarSearchResultsAtom, { ...latest, loading: false });
    }
    log.warn("Bounded sidebar search failed:", error);
  }
}

/**
 * Load native/managed pinned rows through an independent compact cursor.
 * Imported application history has no pin semantics and is excluded by the
 * backend query.
 */
export async function loadMoreSidebarPinnedPage({
  orgIds: requestedOrgIds,
  pageSize = SIDEBAR_DISCOVERY_PAGE_SIZE,
}: Omit<SidebarDiscoveryPageRequest, "includeExternal">): Promise<void> {
  const store = getStore();
  const orgIds = normalizeSidebarDiscoveryOrgIds(requestedOrgIds);
  const scopeKey = sidebarPinnedScopeKey(orgIds);
  const generation = store.get(sidebarDiscoveryGenerationAtom);
  const current = store.get(sidebarPinnedPagesAtom)[scopeKey];
  if (current?.loading || (current && !current.hasMore)) return;

  const boundedPageSize = Math.max(
    1,
    Math.min(pageSize, SIDEBAR_DISCOVERY_PAGE_SIZE)
  );
  const loaded = current?.loaded ?? 0;
  const requestToken = (current?.requestToken ?? 0) + 1;
  store.set(sidebarPinnedPagesAtom, (previous) => ({
    ...previous,
    [scopeKey]: {
      orgIds,
      generation,
      requestToken,
      loaded,
      hasMore: current?.hasMore ?? true,
      loading: true,
      sessions: current?.sessions ?? [],
      cursor: current?.cursor,
    },
  }));

  try {
    const response = await sessionAggregateList({
      pinnedOnly: true,
      orgIds: [...orgIds],
      includeExternalHistory: false,
      limit: boundedPageSize + 1,
      offset: current?.cursor ? 0 : loaded,
      beforeUpdatedAt: current?.cursor?.updatedAt,
      beforeSessionId: current?.cursor?.sessionId,
      sortBy: "updated_at",
      sortOrder: "desc",
    });
    const page = toFrontendSessions(response.sessions)
      .filter(isPrimarySessionListSession)
      .slice(0, boundedPageSize);
    const latest = store.get(sidebarPinnedPagesAtom)[scopeKey];
    if (
      !latest ||
      latest.generation !== generation ||
      latest.requestToken !== requestToken ||
      store.get(sidebarDiscoveryGenerationAtom) !== generation
    ) {
      return;
    }
    store.set(sidebarPinnedPagesAtom, (previous) => ({
      ...previous,
      [scopeKey]: {
        orgIds,
        generation,
        requestToken,
        loaded: loaded + page.length,
        hasMore: response.sessions.length > boundedPageSize,
        loading: false,
        sessions: mergeDiscoveredSessions(latest.sessions, page),
        cursor: page.at(-1)
          ? {
              updatedAt: page.at(-1)!.updated_at,
              sessionId: page.at(-1)!.session_id,
            }
          : latest.cursor,
      },
    }));
  } catch (error) {
    store.set(sidebarPinnedPagesAtom, (previous) => {
      const latest = previous[scopeKey];
      return latest &&
        latest.generation === generation &&
        latest.requestToken === requestToken &&
        store.get(sidebarDiscoveryGenerationAtom) === generation
        ? {
            ...previous,
            [scopeKey]: { ...latest, loading: false },
          }
        : previous;
    });
    log.warn("Bounded pinned-session page failed:", error);
  }
}

/**
 * Discover workspace section headers with a compact GROUP BY query. Facets
 * have their own offset and never populate the ordinary session roster.
 */
export async function loadMoreSidebarWorkspaceFacetPage({
  orgIds: requestedOrgIds,
  includeExternal,
  pageSize = SIDEBAR_DISCOVERY_PAGE_SIZE,
}: SidebarDiscoveryPageRequest): Promise<void> {
  const store = getStore();
  const orgIds = normalizeSidebarDiscoveryOrgIds(requestedOrgIds);
  const policy = sidebarDiscoveryPolicy(includeExternal);
  const scopeKey = sidebarWorkspaceFacetScopeKey({
    orgIds,
    ...policy,
  });
  const current = store.get(sidebarWorkspaceFacetPagesAtom)[scopeKey];
  if (current?.loading || (current && !current.hasMore)) return;

  const boundedPageSize = Math.max(
    1,
    Math.min(pageSize, SIDEBAR_DISCOVERY_PAGE_SIZE)
  );
  const loaded = current?.loaded ?? 0;
  const generation = store.get(sidebarDiscoveryGenerationAtom);
  const requestToken = (current?.requestToken ?? 0) + 1;
  store.set(sidebarWorkspaceFacetPagesAtom, (previous) => ({
    ...previous,
    [scopeKey]: {
      scopeKey,
      generation,
      requestToken,
      loaded,
      hasMore: current?.hasMore ?? true,
      loading: true,
      facets: current?.facets ?? [],
      cursor: current?.cursor,
    },
  }));

  try {
    const response = await sessionWorkspaceFacets({
      orgIds: [...orgIds],
      includeExternalHistory: policy.includeExternalHistory,
      disabledExternalHistorySources: policy.disabledExternalHistorySources,
      limit: boundedPageSize,
      offset: current?.cursor ? 0 : loaded,
      before: current?.cursor,
    });
    const page = response.facets.map((facet) => ({
      repoPath: facet.repoPath ?? null,
      lastUpdatedAtMs: facet.lastUpdatedAtMs,
      sessionCount: facet.sessionCount,
    }));
    const latest = store.get(sidebarWorkspaceFacetPagesAtom)[scopeKey];
    if (
      !latest ||
      latest.generation !== generation ||
      latest.requestToken !== requestToken ||
      store.get(sidebarDiscoveryGenerationAtom) !== generation
    ) {
      return;
    }
    const facetsByPath = new Map(
      latest.facets.map((facet) => [facet.repoPath, facet] as const)
    );
    for (const facet of page) facetsByPath.set(facet.repoPath, facet);
    const facets = Array.from(facetsByPath.values()).sort(
      (left, right) =>
        right.lastUpdatedAtMs - left.lastUpdatedAtMs ||
        (left.repoPath ?? "").localeCompare(right.repoPath ?? "")
    );
    store.set(sidebarWorkspaceFacetPagesAtom, (previous) => ({
      ...previous,
      [scopeKey]: {
        scopeKey,
        generation,
        requestToken,
        loaded: loaded + page.length,
        hasMore: response.hasMore,
        loading: false,
        facets,
        cursor: page.at(-1)
          ? {
              lastUpdatedAtMs: page.at(-1)!.lastUpdatedAtMs,
              repoPath: page.at(-1)!.repoPath,
            }
          : latest.cursor,
      },
    }));
  } catch (error) {
    store.set(sidebarWorkspaceFacetPagesAtom, (previous) => {
      const latest = previous[scopeKey];
      return latest &&
        latest.generation === generation &&
        latest.requestToken === requestToken &&
        store.get(sidebarDiscoveryGenerationAtom) === generation
        ? {
            ...previous,
            [scopeKey]: { ...latest, loading: false },
          }
        : previous;
    });
    log.warn("Workspace-facet page failed:", error);
  }
}
