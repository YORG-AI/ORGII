/**
 * Shared spine for the session loader modules: the logger, the instrumented
 * store accessor, the bulk-read cache window, and the page-fetch result shape
 * every category loader returns.
 */
import type { NativeSidebarSessionCursor } from "@src/api/tauri/session";
import { createLogger } from "@src/hooks/logger";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import type { DateBucketPaginationMap } from "./paginationAtoms";
import type { Session } from "./types";

export const log = createLogger("SessionAtom");

export const getStore = () => getInstrumentedStore();
export const BULK_CACHE_DURATION_MS = 5 * 60 * 1000;

export interface FetchPageResult {
  sessions: Session[];
  hasMore: boolean;
  nextCursor?: NativeSidebarSessionCursor | null;
  dateBuckets?: DateBucketPaginationMap;
}
