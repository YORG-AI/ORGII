/** Live-viewer avatars for the open session, rendered in the ChatHistory pagination toolbar. */
import { useAtomValue } from "jotai";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Tooltip from "@src/components/Tooltip";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { sidebarActiveCloudOrgIdAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  type Org2CloudPresenceEntry,
  org2CloudPresenceAtom,
  resolveCloudSessionRefs,
  viewersForSession,
} from "@src/features/Org2Cloud/org2CloudPresenceAtom";
import { org2CloudRemoteSessionsAtom } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
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
  const selfUserId = useAtomValue(org2CloudAuthAtom)?.userId ?? null;
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
    const refs = resolveCloudSessionRefs(
      session,
      cloudOrgIdsForSession(sessionOrgTags, session.session_id),
      Object.values(remoteSessions).flatMap((entry) => entry.rows),
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
        className="ml-1 inline-flex flex-shrink-0 items-center -space-x-1"
      >
        {viewers.slice(0, MAX_AVATARS).map((viewer) => (
          <span
            key={viewer.userId}
            className="inline-flex size-4 items-center justify-center rounded-full bg-success-6 text-[9px] font-semibold leading-none text-white ring-1 ring-bg-1"
          >
            {(viewer.displayName || "?").slice(0, 1).toUpperCase()}
          </span>
        ))}
        {overflow > 0 && (
          <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-fill-3 px-0.5 text-[9px] font-semibold leading-none text-text-2 ring-1 ring-bg-1">
            +{overflow}
          </span>
        )}
      </span>
    </Tooltip>
  );
};

export default SessionViewersIndicator;
