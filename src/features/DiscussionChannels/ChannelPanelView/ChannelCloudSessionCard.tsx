/**
 * A canonical ORG2 Cloud session reference rendered as a channel attachment.
 *
 * Unlike a local `[session:<id>]` pill, this target remains openable when no
 * local `Session` exists: its org + owner + source tuple is sufficient for the
 * cloud reveal/replay flow to resolve the row on demand. Cached roster data is
 * display enrichment only, never the availability gate.
 */
import { atom, useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { Users } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { resolveAgentIcon } from "@src/config/agentIcons";
import type { CloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";
import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  org2CloudRemoteSessionsAtom,
  remoteSessionsEntryForIdentity,
} from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { useOpenCloudSessionReference } from "@src/features/Org2Cloud/useOpenCloudSessionReference";
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";
import { formatModelNameFull } from "@src/util/formatModelName";
import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";

import {
  ChannelReferenceCard,
  ChannelReferenceCardMeta,
  ChannelReferenceCardMetaItem,
  ChannelReferenceCardTitle,
} from "./ChannelReferenceCard";
import ChannelSessionCard from "./ChannelSessionCard";

const CARD_TEST_ID = "channel-session-card";
const SHORT_ID_LENGTH = 8;
const cloudAuthIdentityAtom = atom((get) => {
  const auth = get(org2CloudAuthAtom);
  return auth ? org2CloudAuthIdentityKey(auth) : null;
});

/**
 * Older channel messages stored only `[session:<source id>]`, before the
 * canonical org + owner + source reference existed. A source id is not
 * globally unique, so recovery is allowed only when the current cloud org's
 * identity-scoped roster contains exactly one live row with that source id.
 */
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

function renderAgentIcon(iconId: string | undefined) {
  const AgentIcon = iconId ? resolveAgentIcon(iconId) : Users;
  return <AgentIcon size={12} strokeWidth={1.75} />;
}

export interface ChannelCloudSessionCardProps {
  reference: CloudSessionReference;
  /** Snapshot carried only by older pill-shaped channel posts. */
  fallbackTitle?: string;
}

const ChannelCloudSessionCard: React.FC<ChannelCloudSessionCardProps> = ({
  reference,
  fallbackTitle,
}) => {
  const { t } = useTranslation("navigation");
  const openReference = useOpenCloudSessionReference();
  const authIdentityKey = useAtomValue(cloudAuthIdentityAtom);

  // Component-owned selector: a roster update for another org/session still
  // evaluates this tiny lookup, but does not re-render every card in the feed.
  const remoteSessionAtom = useMemo(
    () =>
      selectAtom(org2CloudRemoteSessionsAtom, (entries) =>
        remoteSessionsEntryForIdentity(
          entries[reference.orgId],
          authIdentityKey
        )?.rows.find(
          (row) =>
            row.ownerUserId === reference.ownerUserId &&
            row.sourceSessionId === reference.sourceSessionId
        )
      ),
    [
      authIdentityKey,
      reference.orgId,
      reference.ownerUserId,
      reference.sourceSessionId,
    ]
  );
  const remoteSession = useAtomValue(remoteSessionAtom);

  const fallback = fallbackTitle?.trim();
  const shortId = reference.sourceSessionId.slice(-SHORT_ID_LENGTH);
  const title =
    remoteSession?.title.trim() ||
    fallback ||
    `${t("cloud.sessionRef.chipLabel")} ${shortId}`;

  const display = useMemo(
    () =>
      remoteSession
        ? resolveSessionDisplayMetadata({
            kind: "remote",
            session: remoteSession,
          })
        : null,
    [remoteSession]
  );
  const handleOpen = useCallback(() => {
    openReference(reference, { autoReplay: true });
  }, [openReference, reference]);

  return (
    <ChannelReferenceCard
      testId={CARD_TEST_ID}
      identity={{
        "data-session-id": reference.sourceSessionId,
        "data-cloud-session": "true",
      }}
      ariaLabel={t("cloud.channels.feed.sessionCardOpen", { name: title })}
      onOpen={handleOpen}
    >
      <ChannelReferenceCardTitle
        icon={renderAgentIcon(display?.agentIconId)}
        title={title}
      />
      {remoteSession?.ownerDisplayName || display?.modelName ? (
        <ChannelReferenceCardMeta>
          {remoteSession?.ownerDisplayName ? (
            <ChannelReferenceCardMetaItem>
              {remoteSession.ownerDisplayName}
            </ChannelReferenceCardMetaItem>
          ) : null}
          {display?.modelName ? (
            <ChannelReferenceCardMetaItem>
              {formatModelNameFull(display.modelName)}
            </ChannelReferenceCardMetaItem>
          ) : null}
        </ChannelReferenceCardMeta>
      ) : null}
    </ChannelReferenceCard>
  );
};

export interface ChannelSessionReferenceCardProps {
  sessionId: string;
  fallbackTitle: string;
  cloudOrgId: string;
  onOpenLocal: (sessionId: string, fallbackTitle?: string) => void;
}

/**
 * Bridge for pre-canonical session pills in cloud channels.
 *
 * A unique roster match is promoted to the same canonical cloud card/replay
 * path used by a current sidebar drag. Missing or ambiguous matches remain
 * local references; guessing an owner would open the wrong person's session.
 */
export const ChannelSessionReferenceCard: React.FC<
  ChannelSessionReferenceCardProps
> = ({ sessionId, fallbackTitle, cloudOrgId, onOpenLocal }) => {
  const authIdentityKey = useAtomValue(cloudAuthIdentityAtom);
  const legacyRemoteSessionAtom = useMemo(
    () =>
      selectAtom(org2CloudRemoteSessionsAtom, (entries) => {
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
    <ChannelSessionCard
      sessionId={sessionId}
      fallbackTitle={fallbackTitle}
      onOpen={onOpenLocal}
    />
  );
};

export default ChannelCloudSessionCard;
