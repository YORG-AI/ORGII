/**
 * Shared type and interface definitions for the Org2CloudSessionSync push
 * plane: the sync-client dependency seam, prepared-push-event shapes, and
 * the clean-plane/version stamps cached by Org2CloudSessionSyncState.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import type { ImportedReplayCheckpoint } from "./org2CloudSyncAtoms";
import * as org2CloudSyncClient from "./org2CloudSyncClient";

/** Client seam so tests inject fetch-free fakes. */
export type Org2CloudSyncClientDeps = Pick<
  typeof org2CloudSyncClient,
  | "upsertSessionMetadata"
  | "appendSessionEvents"
  | "rewriteSessionEvents"
  | "getSessionEvents"
  | "getOrgRepoScopes"
  | "listOrgSessions"
  | "deleteSession"
> &
  // Optional so existing fetch-free fakes stay valid: the turn-index
  // publish is best-effort progressive enhancement (0012), and a fake
  // without it simply never publishes.
  Partial<Pick<typeof org2CloudSyncClient, "upsertSessionTurnIndex">>;

export interface PreparedPushPlan {
  perEventHashes: string[];
  frozenHashMode: "flat-v1" | "merkle-v1";
  /** Absolute event count, including any validated omitted prefix. */
  totalEventCount: number;
  /** Absolute frozen line, including any validated omitted prefix. */
  frozenEventCount: number;
  /** Frozen line within `PreparedPushEvents.events`. */
  localFrozenEventCount: number;
  tailEvents: SessionEvent[];
  tailHash: string | null;
  frozenChainHash: string;
  importedReplay?: ImportedReplayCheckpoint;
}

export interface PreparedPushEvents {
  stampAtRead: number;
  mode: "full" | "incremental";
  /** Absolute count of validated events omitted from `events`. */
  baseEventCount: number;
  /** Durable native-cache revision covered by this materialization. */
  localContentRevision?: number;
  events: SessionEvent[];
  plan(): Promise<PreparedPushPlan>;
}

export interface CleanEventPlaneStamp {
  verifiedAt: number;
  /** Imported transcript version used for this proof. */
  sourceUpdatedAt?: string;
}

export interface ExternalHistoryVersionObservation {
  sourceUpdatedAt: string;
  observedAt: number;
}
