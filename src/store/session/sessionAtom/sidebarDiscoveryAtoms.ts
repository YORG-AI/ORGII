import { atom } from "jotai";

import { DEFAULT_SESSION_ORG_ID } from "../creatorStateAtom";
import type { NativeSidebarPageCursor } from "./paginationAtoms";
import type { Session } from "./types";

export const SIDEBAR_SEARCH_RESULT_LIMIT = 50;
export const SIDEBAR_DISCOVERY_PAGE_SIZE = 50;

export function normalizeSidebarDiscoveryOrgIds(
  orgIds: readonly string[]
): readonly string[] {
  const normalized = Array.from(
    new Set(orgIds.map((value) => value.trim()).filter(Boolean))
  ).sort();
  return normalized.length > 0 ? normalized : [DEFAULT_SESSION_ORG_ID];
}

export function sidebarPinnedScopeKey(orgIds: readonly string[]): string {
  return JSON.stringify(normalizeSidebarDiscoveryOrgIds(orgIds));
}

export function sidebarWorkspaceFacetScopeKey({
  orgIds,
  includeExternalHistory,
  disabledExternalHistorySources,
}: {
  orgIds: readonly string[];
  includeExternalHistory: boolean;
  disabledExternalHistorySources: readonly string[];
}): string {
  return JSON.stringify({
    orgIds: normalizeSidebarDiscoveryOrgIds(orgIds),
    includeExternalHistory,
    disabledExternalHistorySources: Array.from(
      new Set(
        disabledExternalHistorySources
          .map((source) => source.trim())
          .filter(Boolean)
      )
    ).sort(),
  });
}

export function sidebarSearchQueryKey({
  query,
  orgIds,
  includeExternalHistory,
  disabledExternalHistorySources,
}: {
  query: string;
  orgIds: readonly string[];
  includeExternalHistory: boolean;
  disabledExternalHistorySources: readonly string[];
}): string {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return "";
  return JSON.stringify({
    query: normalizedQuery,
    scope: JSON.parse(
      sidebarWorkspaceFacetScopeKey({
        orgIds,
        includeExternalHistory,
        disabledExternalHistorySources,
      })
    ) as unknown,
  });
}

export interface SidebarSearchResultState {
  queryKey: string;
  generation: number;
  requestToken: number;
  loading: boolean;
  sessions: readonly Session[];
}

export interface SidebarPinnedPageState {
  orgIds: readonly string[];
  generation: number;
  requestToken: number;
  loaded: number;
  hasMore: boolean;
  loading: boolean;
  sessions: readonly Session[];
  cursor?: NativeSidebarPageCursor;
}

export interface SidebarWorkspaceFacet {
  repoPath: string | null;
  lastUpdatedAtMs: number;
  sessionCount: number;
}

export interface SidebarWorkspaceFacetPageState {
  scopeKey: string;
  generation: number;
  requestToken: number;
  loaded: number;
  hasMore: boolean;
  loading: boolean;
  facets: readonly SidebarWorkspaceFacet[];
  cursor?: SidebarWorkspaceFacetCursor;
}

export interface SidebarWorkspaceFacetCursor {
  lastUpdatedAtMs: number;
  repoPath: string | null;
}

export const sidebarSearchResultsAtom = atom<SidebarSearchResultState>({
  queryKey: "",
  generation: 0,
  requestToken: 0,
  loading: false,
  sessions: [],
});
sidebarSearchResultsAtom.debugLabel = "sidebarSearchResultsAtom";

export const sidebarDiscoveryGenerationAtom = atom(0);
sidebarDiscoveryGenerationAtom.debugLabel = "sidebarDiscoveryGenerationAtom";

export const sidebarPinnedPagesAtom = atom<
  Readonly<Record<string, SidebarPinnedPageState>>
>({});
sidebarPinnedPagesAtom.debugLabel = "sidebarPinnedPagesAtom";

export const sidebarWorkspaceFacetPagesAtom = atom<
  Readonly<Record<string, SidebarWorkspaceFacetPageState>>
>({});
sidebarWorkspaceFacetPagesAtom.debugLabel = "sidebarWorkspaceFacetPagesAtom";
