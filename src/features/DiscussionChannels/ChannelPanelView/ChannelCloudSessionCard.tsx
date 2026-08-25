/** Cloud/local session-card bridge for legacy channel references. */
import { atom, useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import React, { useMemo } from "react";

import { LocalSessionReferenceCard } from "@src/components/SessionReferenceCard";
import CloudSessionReferenceCard from "@src/features/Org2Cloud/CloudSessionReferenceCard";
import type { CloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";
import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  org2CloudRemoteSessionsAtom,
  remoteSessionsEntryForIdentity,
} from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

const cloudAuthIdentityAtom = atom((get) => {
  const auth = get(org2CloudAuthAtom);
  return auth ? org2CloudAuthIdentityKey(auth) : null;
});

export function resolveUniqueLegacyCloudSession(
  rows: readonly RemoteTeammateSessionMetadata[],
  sourceSessionId: string
): RemoteTeammateSessionMetadata | null {
  let match: RemoteTeammateSessionMetadata | null = null;
  for (const row of rows) {
    if (row.deletedAt || row.sourceSessionId !== sourceSessionId) continue;
    if (match) return null;
    match = row;
  }
  return match;
}

export interface ChannelCloudSessionCardProps {
  reference: CloudSessionReference;
  fallbackTitle?: string;
}

const ChannelCloudSessionCard: React.FC<ChannelCloudSessionCardProps> = (
  props
) => <CloudSessionReferenceCard {...props} testId="channel-session-card" />;

export interface ChannelSessionReferenceCardProps {
  sessionId: string;
  fallbackTitle: string;
  cloudOrgId: string;
  onOpenLocal: (sessionId: string, fallbackTitle?: string) => void;
}

export const ChannelSessionReferenceCard: React.FC<
  ChannelSessionReferenceCardProps
> = ({ sessionId, fallbackTitle, cloudOrgId, onOpenLocal }) => {
  const authIdentityKey = useAtomValue(cloudAuthIdentityAtom);
  const legacyRemoteSessionAtom = useMemo(
    () =>
      selectAtom(org2CloudRemoteSessionsAtom, (entries) => {
        // Pre-canonical posts stored only a source id. It is not globally
        // unique, so promotion to cloud replay is valid only when the current
        // identity-scoped org roster has exactly one live owner match.
        const entry = remoteSessionsEntryForIdentity(
          entries[cloudOrgId],
          authIdentityKey
        );
        return entry
          ? resolveUniqueLegacyCloudSession(entry.rows, sessionId)
          : null;
      }),
    [authIdentityKey, cloudOrgId, sessionId]
  );
  const remoteSession = useAtomValue(legacyRemoteSessionAtom);
  const reference = useMemo<CloudSessionReference | null>(
    () =>
      remoteSession
        ? {
            version: 1,
            orgId: remoteSession.orgId,
            ownerUserId: remoteSession.ownerUserId,
            sourceSessionId: remoteSession.sourceSessionId,
          }
        : null,
    [remoteSession]
  );

  return reference ? (
    <ChannelCloudSessionCard
      reference={reference}
      fallbackTitle={fallbackTitle}
    />
  ) : (
    <LocalSessionReferenceCard
      sessionId={sessionId}
      fallbackTitle={fallbackTitle}
      onOpen={onOpenLocal}
      testId="channel-session-card"
    />
  );
};

export default ChannelCloudSessionCard;
