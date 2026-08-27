/**
 * Imported (external) history paging.
 *
 * Imported sources fetch lightweight, independent date-bucket pages from
 * ORGII's cache so a busy Today bucket cannot hide Yesterday.
 */
import {
  type ImportedHistorySource,
  isImportedHistorySourceSession,
} from "@src/api/tauri/externalHistory";
import {
  type ExternalHistorySidebarResponse,
  type ExternalHistorySidebarSourceRequest,
  externalHistorySidebarList,
} from "@src/api/tauri/session";
import {
  SESSION_DATE_BUCKET_KEYS,
  getSessionDateBucketRanges,
} from "@src/util/session/sessionDateBuckets";

import type { FetchPageResult } from "./loaderShared";
import { mergeDateBucketPagination, mergeSessions } from "./mergeSessions";
import {
  type DateBucketPaginationMap,
  emptyDateBucketPagination,
} from "./paginationAtoms";
import type { Session } from "./types";

export function replaceImportedFirstPage(
  prev: readonly Session[],
  incoming: readonly Session[],
  shouldReplace: (session: Session) => boolean
): Session[] {
  const retained = prev.filter((session) => !shouldReplace(session));
  return mergeSessions(retained, incoming);
}

export function replaceExternalHistorySourceFirstPage(
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

export async function loadImportedHistorySourcePage(
  source: ImportedHistorySource,
  currentBuckets: DateBucketPaginationMap | undefined,
  pageSize: number
): Promise<FetchPageResult> {
  const pages = await loadImportedHistorySourcePages(
    [{ source, currentBuckets }],
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

export interface ImportedHistoryPageInput {
  source: ImportedHistorySource;
  currentBuckets?: DateBucketPaginationMap;
}

export function buildImportedHistorySourceRequest(
  source: ImportedHistorySource,
  currentBuckets: DateBucketPaginationMap | undefined,
  pageSize: number
): ExternalHistorySidebarSourceRequest | null {
  const ranges = getSessionDateBucketRanges();
  const buckets = ranges
    .filter(({ bucket }) => !currentBuckets || currentBuckets[bucket].hasMore)
    .map(({ bucket, startMs, endMs }) => ({
      bucket,
      startMs,
      endMs,
      limit: pageSize,
      offset: currentBuckets?.[bucket].loaded ?? 0,
    }));
  return buckets.length > 0 ? { source: source.sourceId, buckets } : null;
}

export function importedHistoryPageResult(
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
        pinned: row.pinned ?? false,
        is_active: row.isActive ?? false,
        background: false,
        repoPath: row.repoPath,
        repoRootPath: row.repoRootPath,
        repoRemoteUrls: row.repoRemoteUrls,
        branch: row.branch,
        storagePath: row.storagePath,
        continuationLineageId: row.continuationLineageId,
        clientOrigin: row.clientOrigin,
        clientOriginRaw: row.clientOriginRaw,
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

export async function loadImportedHistorySourcePages(
  inputs: readonly ImportedHistoryPageInput[],
  pageSize: number,
  failures: Map<string, string> = new Map()
): Promise<Map<string, FetchPageResult>> {
  const results = new Map<string, FetchPageResult>();
  const pending = inputs.flatMap(({ source, currentBuckets }) => {
    const request = buildImportedHistorySourceRequest(
      source,
      currentBuckets,
      pageSize
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
    // A source whose store failed to read is UNKNOWN, not empty. Recording it
    // as an empty page would publish an authoritative page of zero ids and
    // retire every row that source owns.
    if (sourceResponse.error) {
      failures.set(source.sourceId, sourceResponse.error);
      continue;
    }
    results.set(
      source.sourceId,
      importedHistoryPageResult(source, currentBuckets, sourceResponse)
    );
  }
  return results;
}

export function importedPageHasProgress(
  dateBuckets: DateBucketPaginationMap | undefined
): boolean {
  return dateBuckets
    ? SESSION_DATE_BUCKET_KEYS.some((bucket) => dateBuckets[bucket].loaded > 0)
    : false;
}
