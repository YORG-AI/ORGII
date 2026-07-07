/**
 * AgentSessionSearchPalette
 *
 * Spotlight sub-mode for opening existing Agent sessions from the cached
 * workstation sidebar session list.
 */
import { useAtomValue } from "jotai";
import { Search } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { useFilteredItems } from "@src/hooks/search";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import {
  renderBreathingStatusDot,
  renderStatusDot,
} from "@src/scaffold/NavigationSidebar/connectors/useSessionMenuItems/statusIndicators";
import {
  loadSidebarSessions,
  sessionLoadingAtom,
  sessionsAtom,
  visitedSessionsAtom,
} from "@src/store/session";
import type { Session } from "@src/store/session";
import { getSessionSearchText } from "@src/util/session/sessionSearch";
import {
  getSessionListDisplayName,
  resolveSessionRowIcon,
} from "@src/util/session/sessionSidebarRow";
import {
  resolveSessionSidebarStatusTone,
  shouldShowSessionSidebarBreathingIndicator,
} from "@src/util/session/sessionSidebarStatusTone";

import type { BasePaletteProps } from "../../shared";
import { PaletteBody, SpotlightShell } from "../../shell";
import type { PathSegment, SpotlightItem } from "../../types";
import { useSelectorKernel } from "../core";

export interface AgentSessionSearchPaletteProps extends BasePaletteProps {
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
  const sessions = useAtomValue(sessionsAtom);
  const sessionsLoading = useAtomValue(sessionLoadingAtom);
  const visitedSessions = useAtomValue(visitedSessionsAtom);
  const [query, setQuery] = useState("");

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
    searchQuery: query,
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

  const items = useMemo<SpotlightItem[]>(
    () =>
      filteredItems.map((session) => {
        const sessionName = getSessionListDisplayName(
          session,
          fallbackSessionLabel
        );
        const statusDotTone = resolveSessionSidebarStatusTone({
          status: session.status,
          mergeStatus: session.mergeStatus,
          visited: visitedSessions.has(session.session_id),
        });
        const showBreathingIndicator =
          shouldShowSessionSidebarBreathingIndicator(session.status);

        return {
          id: session.session_id,
          label: sessionName,
          icon: resolveSessionRowIcon(session),
          type: "option" as const,
          data: {
            statusContent: showBreathingIndicator
              ? renderBreathingStatusDot()
              : renderStatusDot(statusDotTone),
            iconTone: "text1",
          },
          action: () => handleOpenSession(session),
        };
      }),
    [fallbackSessionLabel, filteredItems, handleOpenSession, visitedSessions]
  );

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
        icon: Search,
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
