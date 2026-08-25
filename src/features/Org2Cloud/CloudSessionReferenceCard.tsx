import { atom, useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { Users } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  ReferenceCard,
  ReferenceCardMeta,
  ReferenceCardMetaItem,
  ReferenceCardTitle,
} from "@src/components/SessionReferenceCard";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { formatModelNameFull } from "@src/util/formatModelName";
import { resolveSessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";

import type { CloudSessionReference } from "./cloudSessionReference";
import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";
import {
  org2CloudRemoteSessionsAtom,
  remoteSessionsEntryForIdentity,
} from "./org2CloudRemoteSessionsAtom";
import { useOpenCloudSessionReference } from "./useOpenCloudSessionReference";

const SHORT_ID_LENGTH = 8;
const cloudAuthIdentityAtom = atom((get) => {
  const auth = get(org2CloudAuthAtom);
  return auth ? org2CloudAuthIdentityKey(auth) : null;
});

export interface CloudSessionReferenceCardProps {
  reference: CloudSessionReference;
  fallbackTitle?: string;
  testId?: string;
}

function renderAgentIcon(iconId: string | undefined) {
  const AgentIcon = iconId ? resolveAgentIcon(iconId) : Users;
  return <AgentIcon size={12} strokeWidth={1.75} />;
}

const CloudSessionReferenceCard: React.FC<CloudSessionReferenceCardProps> = ({
  reference,
  fallbackTitle,
  testId = "session-reference-card",
}) => {
  const { t } = useTranslation("navigation");
  const openReference = useOpenCloudSessionReference();
  const authIdentityKey = useAtomValue(cloudAuthIdentityAtom);
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
    <ReferenceCard
      testId={testId}
      identity={{
        "data-session-id": reference.sourceSessionId,
        "data-cloud-session": "true",
      }}
      ariaLabel={t("cloud.channels.feed.sessionCardOpen", { name: title })}
      onOpen={handleOpen}
    >
      <ReferenceCardTitle
        icon={renderAgentIcon(display?.agentIconId)}
        title={title}
      />
      {remoteSession?.ownerDisplayName || display?.modelName ? (
        <ReferenceCardMeta>
          {remoteSession?.ownerDisplayName ? (
            <ReferenceCardMetaItem>
              {remoteSession.ownerDisplayName}
            </ReferenceCardMetaItem>
          ) : null}
          {display?.modelName ? (
            <ReferenceCardMetaItem>
              {formatModelNameFull(display.modelName)}
            </ReferenceCardMetaItem>
          ) : null}
        </ReferenceCardMeta>
      ) : null}
    </ReferenceCard>
  );
};

export default CloudSessionReferenceCard;
