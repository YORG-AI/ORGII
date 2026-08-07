/**
 * AllSessionsSearchPalette
 *
 * Spotlight palette for full-text search across all cached sessions.
 * Results show the best-matched snippet per session with a click-to-navigate
 * action. Uses `cache_search_all_sessions`.
 */
import { useAtomValue } from "jotai";
import { Search } from "lucide-react";
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

import type { BasePaletteProps } from "../../shared";
import { PaletteBody, SpotlightShell } from "../../shell";
import type { PathSegment, SpotlightItem } from "../../types";
import { useSelectorKernel } from "../core";

// ============ PROPS ============

export interface AllSessionsSearchPaletteProps extends BasePaletteProps {
  asBody?: boolean;
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

  const debouncedSearch = useDebouncedCallback((q: string) => {
    if (!q.trim()) {
      setHits([]);
      return;
    }
    setIsLoading(true);
    rpc.sessionCore.cache
      .searchAllSessions({ query: q, limit: 30 })
      .then((results) => setHits(results))
      .catch(() => setHits([]))
      .finally(() => setIsLoading(false));
  }, 200);

  // Reset state when palette closes. Using a ref comparison avoids calling
  // setState synchronously inside an effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (prevIsOpenRef.current && !isOpen) {
      debouncedSearch.cancel();
      setTimeout(() => {
        setQuery("");
        setHits([]);
      }, 0);
    }
    prevIsOpenRef.current = isOpen;
  }, [isOpen, debouncedSearch]);

  useEffect(() => {
    debouncedSearch(query);
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
      hits.map((hit) => {
        const session = sessionMap.get(hit.sessionId);
        const sessionName = session?.name ?? t("chat.session", "Session");
        const cleanSnippet = hit.snippet.replace(/<\/?mark>/g, "");
        return {
          id: hit.sessionId,
          label: sessionName,
          description: cleanSnippet,
          action: () =>
            handleNavigate(hit.sessionId, sessionName, session?.repoPath ?? ""),
        };
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
