/**
 * Retention-windowed org session listing (`cloud_list_org_sessions`), plus the
 * per-row tolerant parse and the keyset pagination fallback cache.
 */
import { createLogger } from "@src/hooks/logger";
import { RemoteTeammateSessionMetadataSchema } from "@src/store/collaboration/protocol";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import { endpointForOrg } from "./org2CloudOrgEndpointRouter";
import {
  callSyncRpc,
  isRpcSignatureUnsupported,
} from "./org2CloudSyncClient.rpc";
import type { CloudOrgSessions } from "./org2CloudSyncClient.schemas";
import { CloudOrgSessionsSchema } from "./org2CloudSyncClient.schemas";

const log = createLogger("Org2CloudSyncClient");

function parseListingRows(
  orgId: string,
  rows: readonly unknown[]
): RemoteTeammateSessionMetadata[] {
  const parsed: RemoteTeammateSessionMetadata[] = [];
  let dropped = 0;
  let firstDrop = "";
  for (const row of rows) {
    const result = RemoteTeammateSessionMetadataSchema.safeParse(row);
    if (result.success) {
      parsed.push(result.data);
    } else {
      dropped += 1;
      // Name the first casualty: a bare count is unattributable once the
      // row ages out of the listing, and "which session, which field" is
      // the entire diagnosis (a dropped row is invisible to teammates).
      if (dropped === 1) {
        const record = row as Record<string, unknown> | null;
        const rowId =
          typeof record?.sourceSessionId === "string"
            ? record.sourceSessionId
            : typeof record?.id === "string"
              ? record.id
              : "<no id>";
        const issue = result.error.issues[0];
        firstDrop =
          `${rowId.slice(0, 64)} ` +
          `(${issue ? `${issue.path.join(".") || "<root>"}: ${issue.message}` : "unknown issue"})`;
      }
    }
  }
  if (dropped > 0) {
    log.rateLimited(
      `listing-malformed-${orgId}`,
      60_000,
      `cloud_list_org_sessions dropped ${dropped} malformed row(s) for ` +
        `org ${orgId}; first: ${firstDrop}`
    );
  }
  return parsed;
}

/** Rows per page for full listings against a 0005 backend. */
export const SESSION_LISTING_PAGE_SIZE = 200;
/** Runaway guard: a full listing never walks more pages than this. */
const SESSION_LISTING_MAX_PAGES = 50;
/** supabaseUrl set of backends that rejected the paged signature (pre-0005). */
const paginationUnsupportedEndpoints = new Set<string>();

export const __SESSION_LISTING_INTERNALS = {
  resetPaginationSupport: () => paginationUnsupportedEndpoints.clear(),
};

/** Member: retention-windowed session listing for one cloud org. */
export async function listOrgSessions(
  accessToken: string,
  orgId: string,
  since?: string,
  signal?: AbortSignal
): Promise<CloudOrgSessions> {
  const endpoint = endpointForOrg(orgId);
  const legacyCall = async () => {
    const payload = await callSyncRpc(
      "cloud_list_org_sessions",
      accessToken,
      {
        p_org_id: orgId,
        since: since ?? null,
      },
      endpoint,
      signal,
      15_000
    );
    const raw = CloudOrgSessionsSchema.parse(payload);
    return {
      ...(raw.serverTime !== undefined ? { serverTime: raw.serverTime } : {}),
      sessions: parseListingRows(orgId, raw.sessions),
    } satisfies CloudOrgSessions;
  };

  let parsed: CloudOrgSessions;
  if (
    since !== undefined ||
    paginationUnsupportedEndpoints.has(endpoint.supabaseUrl)
  ) {
    // Delta pulls stay single-shot (bounded by the cursor overlap); known
    // pre-0005 backends keep the legacy unbounded call.
    parsed = await legacyCall();
  } else {
    // Full listing: walk bounded keyset pages so a large org can never push
    // one giant aggregate through the managed statement timeout.
    const sessions: RemoteTeammateSessionMetadata[] = [];
    let serverTime: string | undefined;
    let cursor: { updatedAt: string; sessionId: string } | undefined;
    let page = 0;
    for (;;) {
      let payload: unknown;
      try {
        payload = await callSyncRpc(
          "cloud_list_org_sessions",
          accessToken,
          {
            p_org_id: orgId,
            since: null,
            p_limit: SESSION_LISTING_PAGE_SIZE,
            p_cursor_updated_at: cursor?.updatedAt ?? null,
            p_cursor_session_id: cursor?.sessionId ?? null,
          },
          endpoint,
          signal,
          15_000
        );
      } catch (error) {
        if (page === 0 && isRpcSignatureUnsupported(error)) {
          paginationUnsupportedEndpoints.add(endpoint.supabaseUrl);
          parsed = await legacyCall();
          break;
        }
        throw error;
      }
      const pageParsed = CloudOrgSessionsSchema.parse(payload);
      sessions.push(...parseListingRows(orgId, pageParsed.sessions));
      serverTime = pageParsed.serverTime ?? serverTime;
      cursor = pageParsed.nextCursor ?? undefined;
      page += 1;
      if (!cursor) {
        parsed = {
          ...(serverTime !== undefined ? { serverTime } : {}),
          sessions,
        };
        break;
      }
      if (page >= SESSION_LISTING_MAX_PAGES) {
        log.warn(
          `cloud_list_org_sessions stopped after ${page} pages for org ${orgId}`
        );
        parsed = {
          ...(serverTime !== undefined ? { serverTime } : {}),
          sessions,
        };
        break;
      }
    }
  }
  // Access-ladder normalization: the cloud column is `events_epoch integer
  // DEFAULT 0 NOT NULL`, so the wire never omits the segment summary — but
  // consumers gate replay/fork/disabled-row on `eventsEpoch === undefined`
  // (the self-hosted "owner published no segments" convention). Without
  // this, a metadata_only row renders clickable and the click dies on the
  // server's ORG2_REPLAY_NOT_AVAILABLE. Strip the summary on rows the
  // access ladder forbids reading anyway.
  return {
    ...parsed,
    sessions: parsed.sessions.map((session) =>
      session.accessMode === "metadata_only"
        ? {
            ...session,
            eventsEpoch: undefined,
            eventsFrozenSeq: undefined,
            eventsCount: undefined,
            eventsTailHash: undefined,
          }
        : session
    ),
  };
}
