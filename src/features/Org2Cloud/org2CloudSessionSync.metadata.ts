/**
 * Cloud session metadata construction shared by Org2CloudSessionSync: the
 * RemoteTeammateSessionMetadata payload built for a local session (restoring
 * fork lineage stripped from Session rows), the server-derived-field strip
 * used to compare a local payload against a server summary, and the
 * cloud-push eligibility check.
 */
import { createCollabAvatarIdentity } from "@src/store/collaboration/protocol";
import {
  COLLAB_IDENTITY_KIND,
  COLLAB_ROLE,
} from "@src/store/collaboration/types";
import type {
  CollabMemberRecord,
  CollabOrgRecord,
  RemoteTeammateSessionMetadata,
} from "@src/store/collaboration/types";
import type { Session } from "@src/store/session/sessionAtom/types";

import {
  createDefaultAccessSettings,
  toRemoteMetadata,
} from "../TeamCollaboration/collabSyncUtils";
import { getSessionForkedFrom } from "../TeamCollaboration/forkSession";
import type { CloudPushAccess } from "./org2CloudAccessSettings";

export function metadataPayloadForHash(
  metadata: RemoteTeammateSessionMetadata
): Partial<RemoteTeammateSessionMetadata> {
  const payload: Partial<RemoteTeammateSessionMetadata> = { ...metadata };
  // These fields are derived by the listing RPC, not authored by
  // cloud_upsert_session_metadata. Excluding them makes a server summary
  // comparable to the exact payload this client would upload.
  // ownerMemberId is also server-authoritative: the synthetic local member
  // uses auth.userId, while the listing returns the org-membership row id.
  // The row id embeds that membership id, so it is server-derived too.
  delete payload.id;
  delete payload.ownerMemberId;
  delete payload.directlySharedWithMe;
  delete payload.eventsEpoch;
  delete payload.eventsFrozenSeq;
  delete payload.eventsCount;
  delete payload.eventsTailHash;
  delete payload.deletedAt;
  delete payload.commentCount;
  delete payload.unresolvedCommentCount;
  return payload;
}

/**
 * Build cloud metadata while restoring fork lineage stripped from Session rows.
 */
export function buildCloudSessionMetadata(
  session: Session,
  orgId: string,
  userId: string,
  displayName: string,
  scopeKey: string | null,
  access: CloudPushAccess,
  avatarUrl?: string
): RemoteTeammateSessionMetadata {
  const org: CollabOrgRecord = { id: orgId, name: "", createdAt: "" };
  const member: CollabMemberRecord = {
    id: userId,
    orgId,
    displayName,
    avatar: createCollabAvatarIdentity(displayName),
    role: COLLAB_ROLE.MEMBER,
    identityKind: COLLAB_IDENTITY_KIND.HUMAN,
    joinedAt: "",
  };
  const settings = {
    ...createDefaultAccessSettings(orgId, userId),
    accessMode: access.accessMode,
    sessionVisibility: { [session.session_id]: access.visibility },
  };
  const withLineage: Session = {
    ...session,
    forkedFrom: getSessionForkedFrom(session),
  };
  return {
    ...toRemoteMetadata(withLineage, org, member, settings, scopeKey),
    ...(avatarUrl ? { ownerAvatarUrl: avatarUrl } : {}),
  };
}

/** True for local sessions that may ever be pushed to the cloud. */
export function isCloudPushCandidate(
  session: Pick<Session, "importedFrom">
): boolean {
  // Imported teammate copies must never round-trip under the local user.
  // The user's own external history has no importedFrom and remains shareable.
  return !session.importedFrom;
}
