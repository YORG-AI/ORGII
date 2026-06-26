import type { TFunction } from "i18next";
import { useSetAtom } from "jotai";
import { useCallback } from "react";

import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import type { SessionTableItem } from "@src/modules/shared/layouts/blocks";
import { collabSessionSnapshotRequestsAtom } from "@src/store/collaboration/collabOrgsAtom";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";
import type {
  CollabMemberRecord,
  RemoteTeammateSessionMetadata,
} from "@src/store/collaboration/types";
import type { Session } from "@src/store/session";

import { COLLAB_SNAPSHOT_REQUEST_STATUS } from "./constants";

interface UseSessionActionsParams {
  orgSessions: RemoteTeammateSessionMetadata[];
  sessions: Session[];
  currentMember: CollabMemberRecord | undefined;
  t: TFunction<"navigation">;
}

export function useSessionActions({
  orgSessions,
  sessions,
  currentMember,
  t,
}: UseSessionActionsParams) {
  const { openSession } = useSessionView();
  const setSnapshotRequests = useSetAtom(collabSessionSnapshotRequestsAtom);

  const handleSelectSession = useCallback(
    (item: SessionTableItem) => {
      const remoteSession = orgSessions.find(
        (session) => session.id === item.id
      );
      if (!remoteSession) return;

      const localSession = sessions.find(
        (session) =>
          session.session_id === remoteSession.sourceSessionId ||
          session.session_id === remoteSession.id
      );

      if (localSession) {
        openSession(
          localSession.session_id,
          localSession.name || localSession.user_input || remoteSession.title,
          localSession.repoPath ?? remoteSession.repoPath
        );
        return;
      }

      if (remoteSession.accessMode !== COLLAB_SESSION_ACCESS_MODE.FULL_REPLAY) {
        setSnapshotRequests((current) => [
          {
            requestId: crypto.randomUUID(),
            orgId: remoteSession.orgId,
            requesterMemberId: currentMember?.id ?? "local-member",
            ownerMemberId: remoteSession.ownerMemberId,
            sourceSessionId: remoteSession.sourceSessionId,
            createdAt: new Date().toISOString(),
            status: COLLAB_SNAPSHOT_REQUEST_STATUS.DENIED,
            error: t("collaboration.access.metadataOnlyDenied"),
          },
          ...current,
        ]);
        return;
      }

      setSnapshotRequests((current) => [
        {
          requestId: crypto.randomUUID(),
          orgId: remoteSession.orgId,
          requesterMemberId: currentMember?.id ?? "local-member",
          ownerMemberId: remoteSession.ownerMemberId,
          sourceSessionId: remoteSession.sourceSessionId,
          createdAt: new Date().toISOString(),
          status: COLLAB_SNAPSHOT_REQUEST_STATUS.PENDING,
        },
        ...current,
      ]);
    },
    [
      currentMember?.id,
      openSession,
      orgSessions,
      sessions,
      setSnapshotRequests,
      t,
    ]
  );

  return { handleSelectSession };
}
