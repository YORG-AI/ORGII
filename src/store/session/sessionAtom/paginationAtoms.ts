/**
 * Per-category pagination state for the sidebar's session list.
 *
 * Native categories use one offset page. Imported-history sources additionally
 * track an offset per date bucket so Today cannot starve Yesterday even when a
 * source has thousands of recent rows. See `SESSION_SIDEBAR_PAGE_SIZE`.
 */
import { atom } from "jotai";

import {
  IMPORTED_HISTORY_SOURCES,
  type ImportedHistoryListCategory,
  isImportedHistoryListCategory,
} from "@src/api/tauri/externalHistory";
import {
  SESSION_DATE_BUCKET_KEYS,
  type SessionDateBucket,
} from "@src/util/session/sessionDateBuckets";

import { DEFAULT_SESSION_ORG_ID } from "../creatorStateAtom";

export type BaseSessionListCategory =
  | "cli_agent"
  | "rust_agent:sde"
  | "rust_agent:agent_org"
  | "rust_agent:os"
  | "rust_agent:wingman"
  | "rust_agent:custom"
  | "human_session";

export type SessionListCategory =
  | BaseSessionListCategory
  | ImportedHistoryListCategory;

export const BASE_SESSION_LIST_CATEGORIES: readonly BaseSessionListCategory[] =
  [
    "cli_agent",
    "rust_agent:sde",
    "rust_agent:agent_org",
    "rust_agent:os",
    "rust_agent:wingman",
    "rust_agent:custom",
    "human_session",
  ];

export const SESSION_LIST_CATEGORIES: readonly SessionListCategory[] = [
  ...BASE_SESSION_LIST_CATEGORIES,
  ...IMPORTED_HISTORY_SOURCES.map((source) => source.listCategory),
];

/**
 * Default page size per native category and per imported-history date bucket.
 * The "Load more" row fetches another bounded page on demand.
 */
export const SESSION_SIDEBAR_PAGE_SIZE = 10;

export interface CategoryPaginationState {
  loaded: number;
  hasMore: boolean;
  loading: boolean;
  generation?: number;
  requestToken?: number;
  cursor?: NativeSidebarPageCursor;
  /**
   * Rows actually consumed by this backend cursor.
   *
   * The session atom can also contain deep-link/exact-load rows, so its
   * contents are not a valid pagination offset. Scoped cursors may reuse only
   * this proven global prefix when deriving their first offset.
   */
  loadedSessionIds?: readonly string[];
  dateBuckets?: DateBucketPaginationMap;
}

export type SessionPaginationScope =
  | {
      kind: "category";
      category: SessionListCategory;
      orgIds: readonly string[];
    }
  | {
      kind: "time";
      bucket: SessionDateBucket;
      orgIds: readonly string[];
    }
  | {
      kind: "workspace";
      repoPath: string | null;
      orgIds: readonly string[];
    };

export interface ScopedSessionPaginationState {
  scope: SessionPaginationScope;
  loading: boolean;
  generation?: number;
  requestToken?: number;
  categories: Partial<Record<SessionListCategory, CategoryPaginationState>>;
}

export type ScopedSessionPaginationMap = Readonly<
  Record<string, ScopedSessionPaginationState>
>;

export function sessionPaginationScopeKey(
  scope: SessionPaginationScope
): string {
  return `v1:${encodeURIComponent(
    JSON.stringify({
      ...scope,
      orgIds: normalizedPaginationOrgIds(scope.orgIds),
    })
  )}`;
}

export function parseSessionPaginationScopeKey(
  key: string
): SessionPaginationScope | null {
  if (!key.startsWith("v1:")) return null;
  try {
    const parsed = JSON.parse(
      decodeURIComponent(key.slice("v1:".length))
    ) as Record<string, unknown>;
    const orgIds = normalizedPaginationOrgIds(
      Array.isArray(parsed.orgIds)
        ? parsed.orgIds.filter(
            (value): value is string => typeof value === "string"
          )
        : []
    );
    if (parsed.kind === "category") {
      return SESSION_LIST_CATEGORIES.includes(
        parsed.category as SessionListCategory
      )
        ? {
            kind: "category",
            category: parsed.category as SessionListCategory,
            orgIds,
          }
        : null;
    }
    if (parsed.kind === "time") {
      return SESSION_DATE_BUCKET_KEYS.includes(
        parsed.bucket as SessionDateBucket
      )
        ? {
            kind: "time",
            bucket: parsed.bucket as SessionDateBucket,
            orgIds,
          }
        : null;
    }
    if (parsed.kind === "workspace") {
      return {
        kind: "workspace",
        repoPath:
          typeof parsed.repoPath === "string" && parsed.repoPath.length > 0
            ? parsed.repoPath
            : null,
        orgIds,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function normalizedPaginationOrgIds(
  orgIds: readonly string[]
): readonly string[] {
  const normalized = Array.from(
    new Set(orgIds.map((value) => value.trim()).filter(Boolean))
  ).sort();
  return normalized.length > 0 ? normalized : [DEFAULT_SESSION_ORG_ID];
}

function isDefaultPersonalScope(scope: SessionPaginationScope): boolean {
  const orgIds = normalizedPaginationOrgIds(scope.orgIds);
  return orgIds.length === 1 && orgIds[0] === DEFAULT_SESSION_ORG_ID;
}

export function categoryCanLoadInScope(
  category: SessionListCategory,
  scope: SessionPaginationScope,
  globalState: CategoryPaginationState,
  scopedState?: CategoryPaginationState
): boolean {
  if (scope.kind === "category" && scope.category !== category) return false;
  const personalScope = normalizedPaginationOrgIds(scope.orgIds).includes(
    DEFAULT_SESSION_ORG_ID
  );
  if (isImportedHistoryListCategory(category) && !personalScope) return false;
  if (scopedState) return scopedState.loading || scopedState.hasMore;
  if (!isDefaultPersonalScope(scope)) {
    return !isImportedHistoryListCategory(category);
  }
  if (scope.kind === "time" && isImportedHistoryListCategory(category)) {
    return globalState.dateBuckets?.[scope.bucket].hasMore ?? false;
  }
  return globalState.loading || globalState.hasMore;
}

export interface DateBucketPaginationState {
  loaded: number;
  hasMore: boolean;
  cursor?: ImportedSidebarPageCursor;
}

export interface NativeSidebarPageCursor {
  updatedAt: string;
  sessionId: string;
}

export interface ImportedSidebarPageCursor {
  updatedAtMs: number;
  sessionId: string;
}

export type DateBucketPaginationMap = Readonly<
  Record<SessionDateBucket, DateBucketPaginationState>
>;

export function emptyDateBucketPagination(): DateBucketPaginationMap {
  return Object.fromEntries(
    SESSION_DATE_BUCKET_KEYS.map((bucket) => [
      bucket,
      { loaded: 0, hasMore: false },
    ])
  ) as DateBucketPaginationMap;
}

const DEFAULT_STATE: CategoryPaginationState = {
  loaded: 0,
  hasMore: false,
  loading: false,
  generation: 0,
  requestToken: 0,
};

export type SessionPaginationMap = Readonly<
  Record<SessionListCategory, CategoryPaginationState>
>;

function makeInitialMap(): SessionPaginationMap {
  const entries = SESSION_LIST_CATEGORIES.map(
    (category) => [category, { ...DEFAULT_STATE }] as const
  );
  return Object.fromEntries(entries) as SessionPaginationMap;
}

export const sessionPaginationAtom =
  atom<SessionPaginationMap>(makeInitialMap());
sessionPaginationAtom.debugLabel = "sessionPaginationAtom";

export const scopedSessionPaginationAtom = atom<ScopedSessionPaginationMap>({});
scopedSessionPaginationAtom.debugLabel = "scopedSessionPaginationAtom";

export function resetPaginationState(generation = 0): SessionPaginationMap {
  const map = makeInitialMap();
  return Object.fromEntries(
    SESSION_LIST_CATEGORIES.map((category) => [
      category,
      { ...map[category], generation },
    ])
  ) as SessionPaginationMap;
}

export const sessionRosterGenerationAtom = atom(0);
sessionRosterGenerationAtom.debugLabel = "sessionRosterGenerationAtom";
