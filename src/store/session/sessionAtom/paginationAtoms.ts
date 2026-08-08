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

export type BaseSessionListCategory =
  | "pinned_native"
  | "cli_agent"
  | "standalone_agent"
  | "agent_org_root"
  | "os_agent"
  | "human_session";

export type SessionListCategory =
  | BaseSessionListCategory
  | ImportedHistoryListCategory;

export const BASE_SESSION_LIST_CATEGORIES: readonly BaseSessionListCategory[] =
  [
    "pinned_native",
    "cli_agent",
    "standalone_agent",
    "agent_org_root",
    "os_agent",
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

export type SidebarStreamPhase = "loading" | "ready" | "exhausted" | "error";

export interface SidebarStreamCursor {
  updatedAt: string;
  sessionId: string;
}

export interface CategoryPaginationState {
  /** IDs that this stream has actually returned in the current generation. */
  sessionIds: readonly string[];
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
  cursor: null,
  phase: "ready",
  generation: 0,
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
