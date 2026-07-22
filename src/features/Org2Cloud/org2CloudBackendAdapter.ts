/**
 * Cloud → collab backend adapter (replay/fork wiring for managed orgs).
 *
 * `importRemoteSession` / `forkTeammateSession` are backend-agnostic and only
 * consume raw, byte-bounded physical-row pages. A cold read starts from the
 * newest page; deltas advance from a physical cursor. Opaque gzip payloads
 * cross the renderer once and are decoded by the Rust staged ingester.
 *
 * Errors are NOT swallowed: `Org2CloudSyncError` (notably code
 * ORG2_RETENTION_EXPIRED, raised when a replay click races past the
 * server-side retention filter) propagates to the caller so the panel can
 * show an upgrade prompt instead of a generic failure.
 */
import type {
  CollabSyncBackendClient,
  GetSessionEventWirePageInput,
  SessionEventWirePage,
} from "../TeamCollaboration/sync/CollabSyncBackend";
import type { CloudEndpoint } from "./config";
import { getSessionEvents } from "./org2CloudSyncClient";

/** Raw bounded client used by the new Rust-backed import path. */
export type CloudSessionWirePageClient = Pick<
  CollabSyncBackendClient,
  "getSessionEventWirePage"
>;

/**
 * The importer passes `remoteSession.id` (`${orgId}:${ownerUserId}:
 * ${sourceSessionId}`, built by `toRemoteMetadata`) as `sessionRowId`,
 * while the cloud RPC keys on the bare `session_id` (= sourceSessionId —
 * see `Org2CloudSyncEngine.upsertMetadataIfChanged`). orgId and
 * ownerUserId are UUIDs (colon-free), so the cloud key is everything after
 * the second colon; a colon-free input is already a bare session id.
 */
export function cloudSessionIdFromRowId(sessionRowId: string): string {
  const parts = sessionRowId.split(":");
  return parts.length >= 3 ? parts.slice(2).join(":") : sessionRowId;
}

/**
 * Build the only replay/fork read capability: bounded opaque wire pages.
 */
export function buildCloudSessionWirePageClient(
  accessToken: string,
  endpoint?: CloudEndpoint
): CloudSessionWirePageClient {
  return {
    async getSessionEventWirePage(
      input: GetSessionEventWirePageInput
    ): Promise<SessionEventWirePage> {
      return getSessionEvents(
        accessToken,
        input.orgId,
        cloudSessionIdFromRowId(input.sessionRowId),
        {
          boundedWirePage: true,
          cursor: input.cursor,
          includeTail: input.includeTail,
          maxSegments: input.maxSegments,
          maxWireBytes: input.maxWireBytes,
          ...(input.shareToken !== undefined
            ? { shareToken: input.shareToken }
            : {}),
          ...(endpoint !== undefined ? { endpoint } : {}),
          ...(input.signal !== undefined ? { signal: input.signal } : {}),
        }
      );
    },
  };
}
