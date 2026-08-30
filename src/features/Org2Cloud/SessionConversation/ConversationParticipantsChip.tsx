import { useAtomValue } from "jotai";
import React from "react";
import { useTranslation } from "react-i18next";

import Tooltip from "@src/components/Tooltip";
import { getSessionForkedFrom } from "@src/features/TeamCollaboration/forkSession";
import {
  HugeiconsIcon,
  MessageMultiple01Icon,
  UserMultipleIcon,
} from "@src/icons";
import { sessionByIdAtom } from "@src/store/session";

import { org2CloudRemoteSessionsAtom } from "../org2CloudRemoteSessionsAtom";
import { resolveConversationFamily } from "./continuationEvents";

/**
 * Family-level conversation counters for the session header: distinct
 * participants (owners across the fork family) and live discussion messages
 * (server-aggregated per row). Renders nothing for sessions without a cloud
 * fork family or discussion.
 */
export function ConversationParticipantsChip({
  sessionId,
}: {
  sessionId: string | null;
}): React.ReactElement | null {
  const { t } = useTranslation("sessions");
  const currentSession = useAtomValue(sessionByIdAtom(sessionId ?? ""));
  const remoteEntries = useAtomValue(org2CloudRemoteSessionsAtom);

  const counters = ((): {
    participants: number;
    discussionCount: number;
  } | null => {
    if (!sessionId) return null;
    const orgId =
      currentSession?.importedFrom?.orgId ??
      (currentSession ? getSessionForkedFrom(currentSession)?.orgId : null) ??
      null;
    const anchorBareSessionId =
      currentSession?.importedFrom?.sourceSessionId ?? sessionId;
    const candidateEntries = orgId
      ? [remoteEntries[orgId]]
      : Object.values(remoteEntries);
    for (const entry of candidateEntries) {
      const rows = entry?.rows;
      if (!rows?.length) continue;
      const family = resolveConversationFamily(rows, anchorBareSessionId);
      if (!family) continue;
      const participants = new Set(
        family.map((member) => member.row.ownerUserId)
      );
      const discussionCount = family.reduce(
        (sum, member) => sum + (member.row.commentCount ?? 0),
        0
      );
      return { participants: participants.size, discussionCount };
    }
    return null;
  })();

  if (!counters) return null;

  return (
    <Tooltip content={t("conversation.participantsTooltip")} position="bottom">
      <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-fill-1 px-1.5 py-0.5 text-[11px] leading-none text-text-3">
        <span className="inline-flex items-center gap-0.5">
          <HugeiconsIcon
            icon={UserMultipleIcon}
            data-icon="users"
            size={11}
            strokeWidth={1.75}
          />
          {counters.participants}
        </span>
        {counters.discussionCount > 0 && (
          <span className="inline-flex items-center gap-0.5">
            <HugeiconsIcon
              icon={MessageMultiple01Icon}
              data-icon="messages-square"
              size={11}
              strokeWidth={1.75}
            />
            {counters.discussionCount}
          </span>
        )}
      </span>
    </Tooltip>
  );
}
