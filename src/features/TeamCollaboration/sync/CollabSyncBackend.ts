/**
 * Backend contract shared by the projects/work-items sync channel and the
 * teammate-session replay/fork importers.
 *
 * Post cloud-parity Phase E the only implementation is the managed ORG2
 * Cloud plane (`org2CloudProjectsClient.createCloudProjectSyncClient` for
 * the channel slice, `org2CloudBackendAdapter.buildCloudSessionFetchClient`
 * for the segments read) — the self-hosted Supabase client and its ~30 RPC
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

export interface GetSessionEventSegmentsInput {
  orgId: string;
  sessionRowId: string;
  /** Return frozen segments with seq strictly greater; tail always included. */
  afterSeq?: number;
  /**
   * Link-share capability (design §6.4): when set, the call authenticates
   * with the token alone (member/root credentials are not sent) and can only
   * read the one session the token is bound to.
   */
  shareToken?: string;
  /** Cancels the fetch + decode (dialog close / attempt supersession). */
  signal?: AbortSignal;
}

export interface SessionEventSegmentRecord {
  seq: number;
  isTail: boolean;
  events: SessionEvent[];
  eventCount: number;
  segmentHash: string;
}

/** Single-statement snapshot of the summary + requested segments. */
export interface SessionEventSegmentsSnapshot {
  /** null ⇒ the owner has never pushed segments for this session. */
  epoch: number | null;
  frozenSeq: number | null;
  tailHash: string | null;
  count: number | null;
  segments: SessionEventSegmentRecord[];
}

export type SessionEventSegmentsSummary = Omit<
  SessionEventSegmentsSnapshot,
  "segments"
>;

/**
 * Optional bounded-memory replay read. Implementations invoke `onPage` in
 * frozen-sequence order and include the mutable tail only on the final page.
 * The returned summary describes that final page's authoritative snapshot.
 */
export type StreamSessionEventSegments = (
  input: GetSessionEventSegmentsInput,
  onPage: (page: SessionEventSegmentsSnapshot) => Promise<void>
) => Promise<SessionEventSegmentsSummary>;

export interface CollabSyncBackendClient {
  upsertProjectMetadata(
    input: UpsertProjectMetadataInput
  ): Promise<CollabUpsertResult>;
  upsertWorkItem(input: UpsertWorkItemInput): Promise<CollabUpsertResult>;
  deleteProjectMetadata(input: DeleteProjectMetadataInput): Promise<void>;
  deleteWorkItemMetadata(input: DeleteWorkItemMetadataInput): Promise<void>;
  getSessionEventSegments(
    input: GetSessionEventSegmentsInput
  ): Promise<SessionEventSegmentsSnapshot>;
  streamSessionEventSegments?: StreamSessionEventSegments;
  listOrgState(input: ListOrgStateInput): Promise<CollabOrgState>;
}
