import { useSetAtom, useStore } from "jotai";
import React, { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import { LocalSessionReferenceCard } from "@src/components/SessionReferenceCard";
import { ROUTES } from "@src/config/routes";
import CloudSessionReferenceCard from "@src/features/Org2Cloud/CloudSessionReferenceCard";
import { openOrReplaceSessionInChatPanelTabAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { sessionByIdAtom } from "@src/store/session";

import type { MarkdownSessionReference } from "./sessionReferenceProjection";

export interface SessionReferenceCardsProps {
  references: readonly MarkdownSessionReference[];
}

/** Structured session attachments appended below rendered chat Markdown. */
const SessionReferenceCards: React.FC<SessionReferenceCardsProps> = ({
  references,
}) => {
  const store = useStore();
  const navigate = useNavigate();
  const openSessionTab = useSetAtom(openOrReplaceSessionInChatPanelTabAtom);
  const handleOpenLocal = useCallback(
    (sessionId: string, fallbackTitle?: string) => {
      const session = store.get(sessionByIdAtom(sessionId));
      openSessionTab({
        sessionId,
        sessionName: session?.name ?? fallbackTitle,
        repoPath: session?.repoPath ?? undefined,
      });
      navigate(ROUTES.workStation.base.path);
    },
    [navigate, openSessionTab, store]
  );

  if (references.length === 0) return null;

  return (
    <div className="mt-2 flex w-full flex-col gap-2">
      {references.map((reference) =>
        reference.kind === "cloud" ? (
          <CloudSessionReferenceCard
            key={`cloud:${reference.reference.orgId}:${reference.reference.ownerUserId}:${reference.reference.sourceSessionId}`}
            reference={reference.reference}
            fallbackTitle={reference.title}
          />
        ) : (
          <LocalSessionReferenceCard
            key={`local:${reference.sessionId}`}
            sessionId={reference.sessionId}
            fallbackTitle={reference.title}
            onOpen={handleOpenLocal}
          />
        )
      )}
    </div>
  );
};

export default SessionReferenceCards;
