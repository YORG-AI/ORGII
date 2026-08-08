/**
 * Per-stream pagination state for the sidebar's session roster.
 *
 * Native streams use a stable `(updatedAt, sessionId)` cursor. Imported-history
 * sources retain their independent date-bucket offsets, but share the same
 * roster IDs and loading/error/exhaustion lifecycle.
 */
import { atom } from "jotai";

import {
  IMPORTED_HISTORY_SOURCES,
  type ImportedHistoryListCategory,
} from "@src/api/tauri/externalHistory";
import {
  SESSION_DATE_BUCKET_KEYS,
  type SessionDateBucket,
} from "@src/util/session/sessionDateBuckets";

import { loadClientCreatedRosterProjections } from "./createdSessionRegistry";
import {
  BASE_SESSION_LIST_CATEGORIES,
  type BaseSessionListCategory,
} from "./sessionRosterCategories";

export {
  BASE_SESSION_LIST_CATEGORIES,
  type BaseSessionListCategory,
} from "./sessionRosterCategories";

export type SessionListCategory =
  | BaseSessionListCategory
  | ImportedHistoryListCategory;

export const SESSION_LIST_CATEGORIES: readonly SessionListCategory[] = [
  ...BASE_SESSION_LIST_CATEGORIES,
  ...IMPORTED_HISTORY_SOURCES.map((source) => source.listCategory),
];

/**
 * Default page size per native category and per imported-history date bucket.
 * The "Load more" row fetches another bounded page on demand.
 */
export const SESSION_SIDEBAR_PAGE_SIZE = 10;

export type SidebarStreamPhase = "loading" | "ready" | "exhausted" | "error";

export interface SidebarStreamCursor {
  updatedAt: string;
  sessionId: string;
}

export interface CategoryPaginationState {
  /** IDs that this stream has actually returned in the current generation. */
  sessionIds: readonly string[];
  /**
   * Backend-confirmed creations that this client must render immediately,
   * before the owning stream returns them on its next page/refresh.
   *
   * Kept separate from `sessionIds` so local registration never pretends to
   * advance or rewrite the authoritative keyset window. Existing roster loads
   * remove IDs from this overlay once the backend has acknowledged them.
   */
  localSessionIds: readonly string[];
  /** Native keyset cursor. Imported sources keep this null. */
  cursor: SidebarStreamCursor | null;
  phase: SidebarStreamPhase;
  /** Monotonic roster refresh generation that produced this window. */
  generation: number;
  dateBuckets?: DateBucketPaginationMap;
}

export interface DateBucketPaginationState {
  loaded: number;
  hasMore: boolean;
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
  sessionIds: [],
  localSessionIds: [],
  cursor: null,
  phase: "ready",
  generation: 0,
};

export type SessionPaginationMap = Readonly<
  Record<SessionListCategory, CategoryPaginationState>
>;

function makeInitialMap(): SessionPaginationMap {
  const projections = loadClientCreatedRosterProjections();
  const entries = SESSION_LIST_CATEGORIES.map(
    (category) =>
      [
        category,
        {
          ...DEFAULT_STATE,
          localSessionIds: projections
            .filter((projection) => projection.category === category)
            .map((projection) => projection.sessionId),
        },
      ] as const
  );
  return Object.fromEntries(entries) as unknown as SessionPaginationMap;
}

export const sessionPaginationAtom =
  atom<SessionPaginationMap>(makeInitialMap());
sessionPaginationAtom.debugLabel = "sessionPaginationAtom";

export function resetPaginationState(): SessionPaginationMap {
  return makeInitialMap();
}
