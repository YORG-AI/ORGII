/**
 * Policy transition used by both directed-member and link sharing.
 *
 * A replay share is useful only when the owner has actually published a full
 * transcript. Keep that invariant in one place: the share UI temporarily
 * installs an explicit `full_replay` override, drains the sync engine, then
 * verifies server truth before it creates any grant. If publication fails,
 * the caller restores the exact previous override with the snapshot below.
 *
 * Visibility is deliberately preserved. A directed grant may be useful for
 * notification/filtering even when the session is already org-visible, and a
 * share action must not silently hide the row from other org members.
 */
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";

import type { CloudAccessSettingsByOrg } from "../org2CloudAccessSettings";
import { withCloudSessionMode } from "../org2CloudAccessSettings";

export interface CloudReplaySharePolicySnapshot {
  /** null means the session previously followed the org minimum. */
  modeOverride: "off" | "metadata_only" | "full_replay" | null;
}

export function applyCloudReplaySharePolicy(
  byOrg: CloudAccessSettingsByOrg,
  orgId: string,
  sessionId: string
): {
  next: CloudAccessSettingsByOrg;
  snapshot: CloudReplaySharePolicySnapshot;
} {
  const snapshot: CloudReplaySharePolicySnapshot = {
    modeOverride: byOrg[orgId]?.sessionModes[sessionId] ?? null,
  };
  return {
    next: withCloudSessionMode(
      byOrg,
      orgId,
      sessionId,
      COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY
    ),
    snapshot,
  };
}

export function restoreCloudReplaySharePolicy(
  byOrg: CloudAccessSettingsByOrg,
  orgId: string,
  sessionId: string,
  snapshot: CloudReplaySharePolicySnapshot
): CloudAccessSettingsByOrg {
  // Compare-and-restore: do not overwrite a newer explicit choice made while
  // publication/grant RPCs were in flight. Only the full-replay value this
  // transaction installed is ours to roll back.
  if (
    byOrg[orgId]?.sessionModes[sessionId] !==
    COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY
  ) {
    return byOrg;
  }
  return withCloudSessionMode(byOrg, orgId, sessionId, snapshot.modeOverride);
}

/**
 * Server-readback assertion. The sync engine intentionally logs ordinary
 * background push failures instead of throwing; explicit sharing must be
 * stricter, so it verifies the exact row and the replay summary before any
 * grant is minted.
 */
export function assertCloudReplayPublished(
  rows: readonly RemoteTeammateSessionMetadata[],
  sessionId: string,
  ownerUserId: string
): void {
  // Session ids originate on clients and can legitimately collide (for
  // example two ORGII instances on one Mac both exposing the same Codex
  // history). Never let a teammate's same-id row prove OUR publication.
  const row = rows.find(
    (candidate) =>
      candidate.sourceSessionId === sessionId &&
      candidate.ownerUserId === ownerUserId
  );
  if (
    !row ||
    row.accessMode !== COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY ||
    row.eventsEpoch === undefined ||
    row.eventsCount === undefined
  ) {
    throw new Error("Full replay publication was not confirmed by the server");
  }
}
