/**
 * Session roster merge primitives shared by the flat-list and sidebar loaders:
 * id-keyed merges, pagination patches, and the bulk-read cache signature.
 */
import type { ExternalHistorySidebarResponse } from "@src/api/tauri/session";

import { getStore } from "./loaderShared";
import {
  type DateBucketPaginationMap,
  type SessionListCategory,
  type SessionPaginationMap,
  emptyDateBucketPagination,
  sessionPaginationAtom,
} from "./paginationAtoms";
import type { Session, SessionStatus } from "./types";

export interface LoadSessionsOptions {
  repoPath?: string;
  orgId?: string;
  projectSlug?: string;
  workItemId?: string;
  status?: SessionStatus;
  limit?: number;
  offset?: number;
  forceRefresh?: boolean;
}

export function loadSessionsCacheSignature(
  options?: LoadSessionsOptions
): string {
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

/**
 * The flat-list roster intentionally excludes imported replay copies (their
 * display entry is the Team Conversations row), but the LOCAL row still owns
 * the open surface's identity — importedFrom drives the comments target,
 * fork-before-send routing, and sender attribution. A wholesale roster
 * replace must therefore carry resident import copies over instead of
 * evicting them mid-view; explicit removal stays the only way they leave.
 */
export function preserveImportedReplayRows(
  prev: readonly Session[],
  next: Session[]
): Session[] {
  const present = new Set(next.map((session) => session.session_id));
  const preserved = prev.filter(
    (session) =>
      !present.has(session.session_id) && Boolean(session.importedFrom)
  );
  if (preserved.length === 0) return next;
  const merged = [...next, ...preserved];
  merged.sort((sessionA, sessionB) =>
    (sessionB.updated_at || "").localeCompare(sessionA.updated_at || "")
  );
  return merged;
}

export function mergeSessions(
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

export function setPaginationFor(
  category: SessionListCategory,
  patch: Partial<SessionPaginationMap[SessionListCategory]>
) {
  const store = getStore();
  store.set(sessionPaginationAtom, (prev) => ({
    ...prev,
    [category]: { ...prev[category], ...patch },
  }));
}

export function mergeDateBucketPagination(
  current: DateBucketPaginationMap | undefined,
  response: ExternalHistorySidebarResponse
): DateBucketPaginationMap {
  const next = { ...(current ?? emptyDateBucketPagination()) };
  for (const page of response.buckets) {
    const previous = next[page.bucket];
    next[page.bucket] = {
      loaded: previous.loaded + page.sessions.length,
      hasMore: page.hasMore,
    };
  }
  return next;
}
