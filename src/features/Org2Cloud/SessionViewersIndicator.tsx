/** Live-viewer avatars for the open session's published header. */
import { useAtomValue } from "jotai";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import PersonAvatar from "@src/components/PersonAvatar";
import Tooltip from "@src/components/Tooltip";
import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { sidebarActiveCloudOrgIdAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  type Org2CloudPresenceEntry,
  org2CloudPresenceAtom,
  resolveCloudSessionRefs,
  viewersForSession,
} from "@src/features/Org2Cloud/org2CloudPresenceAtom";
import {
  org2CloudRemoteSessionsAtom,
  remoteSessionsEntryForIdentity,
} from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import {
  cloudOrgIdsForSession,
  sessionOrgTagsAtom,
} from "@src/features/TeamCollaboration/sessionOrgTagsAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";

const MAX_AVATARS = 3;

interface SessionViewersIndicatorProps {
  /** Session rendered by this ChatHistory surface. */
  sessionId: string | null;
}

const SessionViewersIndicator: React.FC<SessionViewersIndicatorProps> = ({
  sessionId,
}) => {
  const { t } = useTranslation("navigation");
  const presenceMap = useAtomValue(org2CloudPresenceAtom);
  const auth = useAtomValue(org2CloudAuthAtom);
  const selfUserId = auth?.userId ?? null;
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const activeCloudOrgId = useAtomValue(sidebarActiveCloudOrgIdAtom);
  const sessions = useAtomValue(sessionsAtom) as Session[];
  const sessionOrgTags = useAtomValue(sessionOrgTagsAtom);
  const remoteSessions = useAtomValue(org2CloudRemoteSessionsAtom);

  const viewers = useMemo(() => {
    if (!sessionId || !activeCloudOrgId) return [];
    const session = sessions.find(
      (candidate) => candidate.session_id === sessionId
    );
    if (!session) return [];
    // Same identity-filtered active-org read as Slice C in
    // useOrg2CloudRealtime: presence refs below are gated to the active org
    // anyway, and the filter keeps another account's cached rows out of the
    // resolution path during a sign-out/switch commit.
    const refs = resolveCloudSessionRefs(
      session,
      cloudOrgIdsForSession(sessionOrgTags, session.session_id),
      remoteSessionsEntryForIdentity(
        remoteSessions[activeCloudOrgId],
        authIdentityKey
      )?.rows ?? [],
      selfUserId
    );
    const byUser = new Map<string, Org2CloudPresenceEntry>();
    for (const ref of refs) {
      if (ref.orgId !== activeCloudOrgId) continue;
      for (const viewer of viewersForSession(
        presenceMap,
        ref.orgId,
        ref.bareSessionId,
        selfUserId
      )) {
        byUser.set(viewer.userId, viewer);
      }
    }
    return [...byUser.values()];
  }, [
    presenceMap,
    remoteSessions,
    activeCloudOrgId,
    authIdentityKey,
    selfUserId,
    sessionId,
    sessionOrgTags,
    sessions,
  ]);

  if (viewers.length === 0) return null;

  const fullRoster = viewers
    .map((viewer) =>
      t("cloud.sidebar.viewerTooltip", { name: viewer.displayName })
    )
    .join("\n");
  const overflow = viewers.length - MAX_AVATARS;

  return (
    <Tooltip
      content={<span className="whitespace-pre-line">{fullRoster}</span>}
      position="bottom"
      mouseEnterDelay={200}
      framedPanel
    >
      <span
        data-testid="session-viewers-indicator"
        aria-label={fullRoster}
        className="mx-1 inline-flex shrink-0 items-center -space-x-1"
      >
        {viewers.slice(0, MAX_AVATARS).map((viewer) => (
          <span
            key={viewer.userId}
            className="inline-flex rounded-full ring-1 ring-bg-1"
          >
            <PersonAvatar name={viewer.displayName} size={16} />
          </span>
        ))}
        {overflow > 0 && (
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-fill-3 px-0.5 text-[9px] leading-none font-semibold text-text-2 ring-1 ring-bg-1">
            +{overflow}
          </span>
        )}
      </span>
    </Tooltip>
  );
};

export default SessionViewersIndicator;
