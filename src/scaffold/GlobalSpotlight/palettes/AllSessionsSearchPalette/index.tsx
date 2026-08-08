/**
 * AllSessionsSearchPalette
 *
 * Spotlight palette for full-text search across all cached sessions.
 * Results show the best-matched snippet per session with a click-to-navigate
 * action. Uses `cache_search_all_sessions`.
 */
import { useAtomValue } from "jotai";
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type { CrossSessionSearchHit } from "@src/api/tauri/rpc/schemas/sessionCore";
import { useDebouncedCallback } from "@src/hooks/perf";
import { useSessionView } from "@src/hooks/ui/tabs/useSessionView";
import { sessionMapAtom } from "@src/store/session/sessionAtom";

import { ALL_SESSIONS_SEARCH_ICON } from "../../hooks/features/spotlightActionDefinitions.navigation";
import type { BasePaletteProps } from "../../shared";
import { PaletteBody, SpotlightShell } from "../../shell";
import type { PathSegment, SpotlightItem } from "../../types";
import { useSelectorKernel } from "../core";
import { buildAllSessionsSearchItems } from "./allSessionsSearchItems";
import { createLatestOnlySearchRunner } from "./latestOnlySearchRunner";

// ============ PROPS ============

export interface AllSessionsSearchPaletteProps extends BasePaletteProps {
  asBody?: boolean;
}

interface SearchRequest {
  query: string;
  generation: number;
}

// ============ COMPONENT ============

export const AllSessionsSearchPalette: React.FC<
  AllSessionsSearchPaletteProps
> = ({ isOpen, onClose, onGoBackToParent, asBody = false }) => {
  const { t } = useTranslation("sessions");
  const { openSession } = useSessionView();
  const sessionMap = useAtomValue(sessionMapAtom);

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<CrossSessionSearchHit[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const prevIsOpenRef = useRef(isOpen);
  const searchGenerationRef = useRef(0);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const executeSearch = useCallback(
    async ({ query: requestedQuery, generation }: SearchRequest) => {
      if (searchGenerationRef.current !== generation) return;

      setIsLoading(true);
      try {
        const results = await rpc.sessionCore.cache.searchAllSessions({
          query: requestedQuery,
          limit: 30,
        });
        if (searchGenerationRef.current === generation) {
          setHits(results);
        }
      } catch {
        if (searchGenerationRef.current === generation) {
          setHits([]);
        }
      } finally {
        if (searchGenerationRef.current === generation) {
          setIsLoading(false);
        }
      }
    },
    []
  );

  const searchRunner = useMemo(
    () => createLatestOnlySearchRunner(executeSearch),
    [executeSearch]
  );

  const debouncedSearch = useDebouncedCallback(
    (q: string, generation: number) => {
      if (searchGenerationRef.current !== generation) return;

      if (!q.trim()) {
        searchRunner.clearPending();
        setHits([]);
        setIsLoading(false);
        return;
      }
      void searchRunner.submit({ query: q, generation });
    },
    200
  );

  useEffect(
    () => () => {
      searchGenerationRef.current += 1;
      searchRunner.dispose();
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    },
    [searchRunner]
  );

  // Reset state when palette closes. Using a ref comparison avoids calling
  // setState synchronously inside an effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (prevIsOpenRef.current && !isOpen) {
      searchGenerationRef.current += 1;
      debouncedSearch.cancel();
      searchRunner.clearPending();
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => {
        resetTimerRef.current = null;
        setQuery("");
        setHits([]);
        setIsLoading(false);
      }, 0);
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, debouncedSearch, searchRunner]);

  useEffect(() => {
    searchGenerationRef.current += 1;
    debouncedSearch(query, searchGenerationRef.current);
  }, [query, debouncedSearch]);

  const handleGoBack = useCallback(() => {
    if (onGoBackToParent) {
      onGoBackToParent();
      return;
    }
    onClose();
  }, [onClose, onGoBackToParent]);

  const handleNavigate = useCallback(
    (sessionId: string, sessionName: string, repoPath: string) => {
      openSession(sessionId, sessionName, repoPath);
      onClose();
    },
    [openSession, onClose]
  );

  const items = useMemo<SpotlightItem[]>(
    () =>
      buildAllSessionsSearchItems({
        hits,
        sessionMap,
        fallbackSessionLabel: t("chat.session", "Session"),
        onNavigate: handleNavigate,
      }),
    [handleNavigate, hits, sessionMap, t]
  );

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
        id: "search-all-sessions",
        label: t(
          "common:selectors.spotlight.actions.searchAllSessions.pillLabel",
          "Search All Sessions"
        ),
        icon: ALL_SESSIONS_SEARCH_ICON,
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
        "common:selectors.spotlight.actions.searchAllSessions.placeholder",
        "Search across all sessions..."
      )}
      path={path}
      onRemoveSegment={handleGoBack}
      isLoading={isLoading}
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
