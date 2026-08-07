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
} from "@src/api/tauri/externalHistory";
import {
  SESSION_DATE_BUCKET_KEYS,
  type SessionDateBucket,
} from "@src/util/session/sessionDateBuckets";

export type BaseSessionListCategory = "cli_agent" | "rust_agent";

export type SessionListCategory =
  | BaseSessionListCategory
  | ImportedHistoryListCategory;

export const BASE_SESSION_LIST_CATEGORIES: readonly BaseSessionListCategory[] =
  ["cli_agent", "rust_agent"];

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
  loaded: 0,
  hasMore: false,
  loading: false,
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

export function resetPaginationState(): SessionPaginationMap {
  return makeInitialMap();
}
