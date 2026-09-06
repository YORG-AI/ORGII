import { memo, useMemo } from "react";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import { useSessionEventIngestion } from "@src/engines/SessionCore/sync/useSessionEventIngestion";
import { isActiveStatus } from "@src/types/session/session";

const PENDING_MEMBER_SESSION_PREFIX = "agent-org-member-pending:";

interface AgentOrgGroupChatLiveSessionsProps {
  enabled: boolean;
  excludeSessionId?: string | null;
  members: ReadonlyArray<AgentOrgRunMemberView>;
}

interface LiveSessionTapProps {
  sessionId: string;
}

function LiveSessionTap({ sessionId }: LiveSessionTapProps) {
  useSessionEventIngestion(sessionId);
  return null;
}

export const AgentOrgGroupChatLiveSessions = memo(
  ({
    enabled,
    excludeSessionId,
    members,
  }: AgentOrgGroupChatLiveSessionsProps) => {
    const sessionIds = useMemo(() => {
      if (!enabled) return [];
      const ids = new Set<string>();
      for (const member of members) {
        const runtime = member.sessionRuntime;
        const sessionId = runtime?.sessionId;
        if (
          !sessionId ||
          sessionId === excludeSessionId ||
          sessionId.startsWith(PENDING_MEMBER_SESSION_PREFIX)
        ) {
          continue;
        }
        // Only subscribe IPC channels for sessions that are still active.
        // Completed/failed/cancelled sessions will never emit again — holding
        // a channel open for them wastes Rust registry slots and keeps the
        // IPC bus busy for no reason.
        if (!isActiveStatus(runtime?.status)) {
          continue;
        }
        ids.add(sessionId);
      }
      return [...ids];
    }, [enabled, excludeSessionId, members]);

    if (!enabled) return null;

    return (
      <>
        {sessionIds.map((sessionId) => (
          <LiveSessionTap key={sessionId} sessionId={sessionId} />
        ))}
      </>
    );
  }
);

AgentOrgGroupChatLiveSessions.displayName = "AgentOrgGroupChatLiveSessions";
