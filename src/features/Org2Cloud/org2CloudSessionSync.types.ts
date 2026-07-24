/**
 * Shared type and interface definitions for the Org2CloudSessionSync push
 * plane: the sync-client dependency seam, prepared-push-event shapes, and
 * the clean-plane/version stamps cached by Org2CloudSessionSyncState.
 */
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import * as org2CloudSyncClient from "./org2CloudSyncClient";

/** Client seam so tests inject fetch-free fakes. */
type Org2CloudSyncClientMethods = Pick<
  typeof org2CloudSyncClient,
  | "upsertSessionMetadata"
  | "appendSessionEvents"
  | "appendSessionEventWires"
  | "rewriteSessionEvents"
  | "rewriteSessionEventWires"
  | "getOrgRepoScopes"
  | "listOrgSessions"
  | "deleteSession"
>;

export interface Org2CloudSyncClientDeps extends Org2CloudSyncClientMethods {
  getSessionEvents(
    accessToken: string,
    orgId: string,
    sessionId: string,
    options?:
      | org2CloudSyncClient.GetSessionEventsOptions
      | org2CloudSyncClient.GetSessionEventWirePageOptions
  ): Promise<
    | org2CloudSyncClient.CloudSessionEventsSnapshot
    | org2CloudSyncClient.CloudSessionEventWirePage
  >;
}

export interface PreparedPushPlan {
  perEventHashes: string[];
  frozenEventCount: number;
  tailEvents: SessionEvent[];
  tailHash: string | null;
  frozenChainHash: string;
}

export interface PreparedPushEvents {
  stampAtRead: number;
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
