/**
 * Backend contract shared by the projects/work-items sync channel and the
 * teammate-session replay/fork importers.
 *
 * Post cloud-parity Phase E the only implementation is the managed ORG2
 * Cloud plane (`org2CloudProjectsClient.createCloudProjectSyncClient` for
 * the channel slice, `org2CloudBackendAdapter.buildCloudSessionWirePageClient`
 * for bounded replay reads) — the self-hosted Supabase client and its ~30 RPC
 * input types were deleted with the in-app self-hosted track. What remains
 * is exactly the surface those cloud adapters implement.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import type {
  CollabProjectMetadataRecord,
  CollabWorkItemMetadataRecord,
} from "@src/store/collaboration/types";

export interface UpsertProjectMetadataInput {
  orgId: string;
  project: CollabProjectMetadataRecord;
  /** OCC base version; defaults to `project.version` when omitted. */
  baseVersion?: number | null;
}

export interface UpsertWorkItemInput {
  orgId: string;
  workItem: CollabWorkItemMetadataRecord;
  /** OCC base version; defaults to `workItem.version` when omitted. */
  baseVersion?: number | null;
}

/** Server acknowledgement of an OCC upsert: the row's new version. */
export interface CollabUpsertResult {
  id: string;
  version: number;
}

export interface DeleteProjectMetadataInput {
  orgId: string;
  projectId: string;
}

export interface DeleteWorkItemMetadataInput {
  orgId: string;
  workItemId: string;
}

/** Server-allocated short id (design §16.5): `<PREFIX>-<n>`. */
export interface AllocateWorkItemShortIdResult {
  shortId: string;
  n: number;
}

export interface ListOrgStateInput {
  orgId: string;
  sinceTimestamp?: string;
}

/**
 * Projects/work-items delta consumed by `ProjectSyncChannel.applyPulledState`
 * (rows = payload merged with version/updatedByMemberId/deletedAt).
 */
export interface CollabOrgState {
  serverTime?: string;
  projects: CollabProjectMetadataRecord[];
  workItems: CollabWorkItemMetadataRecord[];
}

// ---------------------------------------------------------------------------
// Segments data plane (design §7). Events are stored as an immutable frozen
// prefix (append-only numbered segments) plus one mutable tail segment.
// The client layer owns gzip + segment hashing; callers pass plain events.
// ---------------------------------------------------------------------------

/** One frozen segment to write: `seq` is server-side ordering (1-based). */
export interface SessionEventsSegmentInput {
  seq: number;
  events: SessionEvent[];
}

/**
 * Hard transport budgets for one raw replay page. These limits apply to the
 * physical cloud rows, not logical events: one Replay Attachment V2 event may
 * span several rows whose intermediate `eventCount` is zero.
 */
export const SESSION_EVENT_WIRE_MAX_SEGMENT_BYTES = 256 * 1024;
export const SESSION_EVENT_WIRE_MAX_PAGE_BYTES = 4 * 1024 * 1024;
export const SESSION_EVENT_WIRE_MAX_PAGE_SEGMENTS = 200;

/**
 * A physical-row cursor. Forward pages are used for deltas/rebuilds;
 * backward pages make a cold open start at the newest frozen rows instead of
 * downloading the complete history. `throughSeq` pins a multi-page forward
 * read to one frozen high-water mark.
 */
export type SessionEventWirePageCursor =
  | {
      direction: "forward";
      afterSeq: number;
      throughSeq?: number;
    }
  | {
      direction: "backward";
      beforeSeq?: number;
    };

export interface GetSessionEventWirePageInput {
  orgId: string;
  sessionRowId: string;
  cursor: SessionEventWirePageCursor;
  /**
   * Ask the server to include the current mutable tail state. A latest-page
   * cold open and a forward delta set this; older backward pages do not.
   */
  includeTail: boolean;
  maxSegments: number;
  maxWireBytes: number;
  shareToken?: string;
  signal?: AbortSignal;
}

/**
 * Opaque compressed physical row. Consumers must persist/stream these rows
 * without decoding them into a renderer-sized `SessionEvent[]`.
 */
export interface SessionEventSegmentWireRecord {
  seq: number;
  payloadGz: string;
  eventCount: number;
  segmentHash: string;
}

/** One fail-closed, byte-bounded page from a single epoch snapshot. */
export interface SessionEventWirePage {
  epoch: number | null;
  frozenSeq: number | null;
  tailHash: string | null;
  count: number | null;
  segments: SessionEventSegmentWireRecord[];
  /** True only when this response represents the requested current tail. */
  tailIncluded: boolean;
  hasMore: boolean;
  /** Physical-row continuation; never a logical event-count cursor. */
  nextCursor: SessionEventWirePageCursor | null;
  /** Sum of compact UTF-8 JSON bytes for `segments`. */
  returnedWireBytes: number;
}

export interface CollabSyncBackendClient {
  upsertProjectMetadata(
    input: UpsertProjectMetadataInput
  ): Promise<CollabUpsertResult>;
  upsertWorkItem(input: UpsertWorkItemInput): Promise<CollabUpsertResult>;
  deleteProjectMetadata(input: DeleteProjectMetadataInput): Promise<void>;
  deleteWorkItemMetadata(input: DeleteWorkItemMetadataInput): Promise<void>;
  getSessionEventWirePage(
    input: GetSessionEventWirePageInput
  ): Promise<SessionEventWirePage>;
  listOrgState(input: ListOrgStateInput): Promise<CollabOrgState>;
}
