/**
 * AgentSessionSearchPalette
 *
 * Spotlight sub-mode for opening existing Agent sessions from the cached
 * workstation sidebar session list.
 */
import { useAtomValue } from "jotai";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { CloudSessionReference } from "@src/features/Org2Cloud/cloudSessionReference";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { org2CloudRemoteSessionsAtom } from "@src/features/Org2Cloud/org2CloudRemoteSessionsAtom";
import { useOpenCloudSessionReference } from "@src/features/Org2Cloud/useOpenCloudSessionReference";
import { useFilteredItems } from "@src/hooks/search";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { Search01Icon } from "@src/icons";
import {
  loadSidebarSessions,
  sessionLoadingAtom,
  sessionsAtom,
  visitedSessionsAtom,
} from "@src/store/session";
import type { Session } from "@src/store/session";
import { getSessionSearchText } from "@src/util/session/sessionSearch";
import { getSessionListDisplayName } from "@src/util/session/sessionSidebarRow";

import {
  buildCloudSessionReferenceItem,
  buildSpotlightSessionItems,
  resolveAgentSessionSearchInput,
  resolveSpotlightCloudSessionPresentation,
} from "../../hooks/features/spotlightSessionSearch";
import type { BasePaletteProps } from "../../shared";
import { PaletteBody, SpotlightShell } from "../../shell";
import type { PathSegment, SpotlightItem } from "../../types";
import { useSelectorKernel } from "../core";

interface AgentSessionSearchPaletteProps extends BasePaletteProps {
  asBody?: boolean;
}

function getSessionTimestamp(session: Session): string {
  return session.updated_at || session.updated_time || session.created_at;
}

export const AgentSessionSearchPalette: React.FC<
  AgentSessionSearchPaletteProps
> = ({ isOpen, onClose, onGoBackToParent, asBody = false }) => {
  const { t } = useTranslation();
  const { openSession } = useSessionView();
  const openCloudSessionReference = useOpenCloudSessionReference();
  const sessions = useAtomValue(sessionsAtom);
  const sessionsLoading = useAtomValue(sessionLoadingAtom);
  const visitedSessions = useAtomValue(visitedSessionsAtom);
  const cloudAuth = useAtomValue(org2CloudAuthAtom);
  const cloudRemoteSessions = useAtomValue(org2CloudRemoteSessionsAtom);
  const [query, setQuery] = useState("");
  const resolvedSearchInput = useMemo(
    () => resolveAgentSessionSearchInput(query),
    [query]
  );

  useEffect(() => {
    if (!isOpen) return;
    void loadSidebarSessions();
  }, [isOpen]);

  const sortedSessions = useMemo(
    () =>
      sessions
        .slice()
        .sort((sessionA, sessionB) =>
          getSessionTimestamp(sessionB).localeCompare(
            getSessionTimestamp(sessionA)
          )
        ),
    [sessions]
  );

  const fallbackSessionLabel = t("navigation:routes.session", "Session");
  const { filteredItems } = useFilteredItems({
    items: sortedSessions,
    searchQuery: resolvedSearchInput.query,
    getSearchText: (session) =>
      getSessionSearchText(session, fallbackSessionLabel),
  });

  const handleGoBack = useCallback(() => {
    if (onGoBackToParent) {
      onGoBackToParent();
      return;
    }
    onClose();
  }, [onClose, onGoBackToParent]);

  const handleOpenSession = useCallback(
    (session: Session) => {
      openSession(
        session.session_id,
        getSessionListDisplayName(session, fallbackSessionLabel),
        session.repoPath
      );
      onClose();
    },
    [fallbackSessionLabel, onClose, openSession]
  );

  const handleOpenCloudReference = useCallback(
    (reference: CloudSessionReference) => {
      if (openCloudSessionReference(reference, { autoReplay: true })) {
        onClose();
      }
    },
    [onClose, openCloudSessionReference]
  );

  const items = useMemo<SpotlightItem[]>(() => {
    if (resolvedSearchInput.reference) {
      const reference = resolvedSearchInput.reference;
      return [
        buildCloudSessionReferenceItem({
          reference,
          ...resolveSpotlightCloudSessionPresentation({
            reference,
            fallbackLabel: t(
              "navigation:cloud.sessionRef.chipLabel",
              "Team session"
            ),
            auth: cloudAuth,
            remoteEntries: cloudRemoteSessions,
            localSessions: sessions,
          }),
          onSelect: handleOpenCloudReference,
        }),
      ];
    }

    return buildSpotlightSessionItems({
      sessions: filteredItems,
      fallbackSessionLabel,
      visitedSessions,
      query: resolvedSearchInput.query,
      onSelect: handleOpenSession,
    });
  }, [
    fallbackSessionLabel,
    filteredItems,
    cloudAuth,
    cloudRemoteSessions,
    handleOpenCloudReference,
    handleOpenSession,
    resolvedSearchInput.query,
    resolvedSearchInput.reference,
    sessions,
    t,
    visitedSessions,
  ]);

  const isItemSelectable = useCallback((item: SpotlightItem) => {
    return !item.data?.isHeader && !item.data?.disabled;
  }, []);

  const handleExternalKeyDown = useCallback(
    (
      event: React.KeyboardEvent<HTMLInputElement>,
      internal: (event: React.KeyboardEvent<HTMLInputElement>) => void
    ) => {
      if (
        (event.key === "Backspace" || event.key === "Delete") &&
        query === ""
      ) {
        event.preventDefault();
        handleGoBack();
        return;
      }

      internal(event);
    },
    [handleGoBack, query]
  );

  const kernel = useSelectorKernel({
    isOpen,
    onClose,
    items,
    isItemSelectable,
    hasModalState: asBody || !!onGoBackToParent,
    onGoBack: handleGoBack,
    onReset: () => setQuery(""),
    externalSearchQuery: query,
    externalSetSearchQuery: setQuery,
    externalHandleKeyDown: handleExternalKeyDown,
  });

  const path = useMemo<PathSegment[]>(
    () => [
      {
        type: "action",
        id: "search-agent-sessions",
        label: t(
          "selectors.spotlight.actions.searchAgentSessions.pillLabel",
          "Search Sessions"
        ),
        icon: Search01Icon,
        color: "primary",
      },
    ],
    [t]
  );

  const body = (
    <PaletteBody
      kernel={kernel}
      items={items}
      placeholder={t(
        "selectors.spotlight.actions.searchAgentSessions.placeholder",
        "Search Agent sessions..."
      )}
      path={path}
      onRemoveSegment={handleGoBack}
      isLoading={sessionsLoading && sessions.length === 0}
      containerHeight={400}
    />
  );

  if (asBody) return body;

  return (
    <SpotlightShell isOpen={isOpen} onClose={onClose} hasActiveAction>
      {body}
    </SpotlightShell>
  );
};
