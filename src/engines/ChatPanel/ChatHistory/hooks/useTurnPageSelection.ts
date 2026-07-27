/**
 * Turn-page selection state, navigation, and lazy-load wiring.
 *
 * Split into two hooks because the selected page index has to be threaded
 * back into `useChatTurnPagination` (which produces `pageCount`/`pages`),
 * so the state hook runs *before* `useChatTurnPagination` and the
 * navigation hook (which depends on its outputs) runs *after*.
 */
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { resolveExternalReplayTarget } from "@src/api/tauri/externalHistory/replay";
import type { SessionLoadStatus } from "@src/engines/SessionCore";
import { externalReplayPlaceholderId } from "@src/engines/SessionCore/sync/externalReplayTurnState";
import {
  loadSessionTurnBodyIntoStore,
  pruneLoadedTurnBodies,
} from "@src/engines/SessionCore/turns";
import { TURN_PAGE_PREFETCH_RADIUS } from "@src/engines/SessionCore/turns/turnWindowConfig";
import { createLogger } from "@src/hooks/logger";
import {
  isCodexAppSession,
  isCollaborationImportedSession,
} from "@src/util/session/sessionDispatch";

import {
  formatReplayTurnPageTimeLabel,
  formatTurnPageTimeLabel,
} from "../utils/turnPageFormatting";
import type { ChatGroupMeta } from "./useChatGroups";
import type { UseChatTurnPaginationReturn } from "./useChatTurnPagination";

const logger = createLogger("ChatHistory");

type TurnPage = UseChatTurnPaginationReturn["pages"][number];

function getTurnIdsToLoadForPage(
  page: TurnPage,
  groupMeta: ChatGroupMeta[]
): string[] {
  const turnIds = new Set<string>();
  for (
    let groupIndex = page.startGroupIndex;
    groupIndex <= page.endGroupIndex;
    groupIndex++
  ) {
    const unloadedTurn = groupMeta[groupIndex]?.unloadedTurn;
    if (unloadedTurn) turnIds.add(unloadedTurn.turnId);
  }
  if (turnIds.size > 0) return [...turnIds];

  const summary = page.replayTurnSummary;
  if (!summary || summary.bodyEventCount <= 0) return [];
  const hasLoadedBody =
    page.replayBodyLoaded && page.flatEndIndex > page.flatStartIndex;
  // A virtual replay page first has a local placeholder id, then receives
  // the provider's real turn id when its compact header arrives. The body
  // request must keep one stable identity across that transition; otherwise
  // React starts a second request for the same turn and Rust's request-token
  // guard can invalidate the first publication before the UI consumes it.
  return hasLoadedBody ? [] : [externalReplayPlaceholderId(summary.turnIndex)];
}

interface TurnPageSelection {
  pageIndex: number | null;
  sessionId: string | null;
}

export interface UseTurnPageSelectionStateReturn {
  selectedTurnPageIndex: number;
  setTurnPageSelection: Dispatch<SetStateAction<TurnPageSelection>>;
  turnPageListOpen: boolean;
  setTurnPageListOpen: Dispatch<SetStateAction<boolean>>;
  turnPageSortAscending: boolean;
  setTurnPageSortAscending: Dispatch<SetStateAction<boolean>>;
}

/**
 * Selection state half — runs before `useChatTurnPagination` so the
 * resolved index can drive its `activePageIndex` input.
 */
export function useTurnPageSelectionState(
  activeId: string | null
): UseTurnPageSelectionStateReturn {
  const [turnPageSelection, setTurnPageSelection] = useState<TurnPageSelection>(
    { pageIndex: null, sessionId: null }
  );
  const [turnPageListOpen, setTurnPageListOpen] = useState(false);
  const [turnPageSortAscending, setTurnPageSortAscending] = useState(false);

  const isExplicitSelection =
    turnPageSelection.pageIndex !== null &&
    turnPageSelection.sessionId === activeId;
  const selectedTurnPageIndex =
    isExplicitSelection && turnPageSelection.pageIndex !== null
      ? turnPageSelection.pageIndex
      : Number.MAX_SAFE_INTEGER;

  return {
    selectedTurnPageIndex,
    setTurnPageSelection,
    turnPageListOpen,
    setTurnPageListOpen,
    turnPageSortAscending,
    setTurnPageSortAscending,
  };
}

interface UseTurnPageNavigationOptions {
  activeId: string | null;
  pageCount: number;
  currentPageIndex: number;
  pages: TurnPage[];
  groupMeta: ChatGroupMeta[];
  sessionLoadStatus: SessionLoadStatus;
  turnPaginationEnabled: boolean;
  setTurnPageSelection: Dispatch<SetStateAction<TurnPageSelection>>;
  setTurnPageListOpen: Dispatch<SetStateAction<boolean>>;
}

export interface UseTurnPageNavigationReturn {
  selectTurnPage: (pageIndex: number) => void;
  handlePreviousTurnPage: () => void;
  handleNextTurnPage: () => void;
  handleLastTurnPage: () => void;
  turnPaginationReady: boolean;
  currentTurnPageLabel: string;
  currentTurnPageTimeLabel: string;
}

/**
 * Navigation handlers + lazy body-load effect for the current page and
 * its neighbours. Depends on `useChatTurnPagination` outputs so it must
 * be called after that hook.
 */
export function useTurnPageNavigation({
  activeId,
  pageCount,
  currentPageIndex,
  pages,
  groupMeta,
  sessionLoadStatus,
  turnPaginationEnabled,
  setTurnPageSelection,
  setTurnPageListOpen,
}: UseTurnPageNavigationOptions): UseTurnPageNavigationReturn {
  const { t } = useTranslation();
  const requiresExplicitTurnLoad = isCollaborationImportedSession(activeId);

  // Tracks `${activeId}:${turnId}` keys we've already kicked off a body
  // load for so the prefetch effect doesn't refire on every render.
  //
  // We keep this as a Set ref (not state) on purpose: the prefetch effect
  // mutates it synchronously during iteration, and we do NOT want a
  // ref-change to retrigger the effect. A separate `loadedTurnIds` state
  // (below) is used by the readiness gate so the React tree re-renders
  // when an empty turn resolves — covering the deadlock where a turn
  // body returns 0 events and the `unloadedTurn` placeholder never goes
  // away because the store never sees a `mergeEvents` call.
  const autoLoadedTurnKeysRef = useRef<Set<string>>(new Set());
  // Tracks turns we've finished loading (success path, even when 0 events).
  // Tagged by sessionId so the readiness gate ignores entries from a
  // previous session without needing an effect to clear them on switch.
  const [loadedTurnIds, setLoadedTurnIds] = useState<{
    sessionId: string | null;
    turnIds: Set<string>;
  }>({ sessionId: null, turnIds: new Set() });

  useEffect(() => {
    autoLoadedTurnKeysRef.current.clear();
  }, [activeId]);

  useEffect(() => {
    if (
      !turnPaginationEnabled ||
      !activeId ||
      sessionLoadStatus !== "loaded" ||
      requiresExplicitTurnLoad
    ) {
      return;
    }

    const pageIndexes: number[] = [];
    // Codex rollout files can approach a GiB. Its source loader has a byte
    // offset index, but fetching an adjacent body is still real file I/O;
    // wait until that round is selected instead of speculatively loading it
    // just because the latest round opened.
    const prefetchRadius = isCodexAppSession(activeId)
      ? 0
      : TURN_PAGE_PREFETCH_RADIUS;
    for (let offset = -prefetchRadius; offset <= prefetchRadius; offset++) {
      pageIndexes.push(currentPageIndex + offset);
    }
    const protectedTurnIds = new Set<string>();
    for (const pageIndex of pageIndexes) {
      const page = pages[pageIndex];
      if (!page) continue;
      for (
        let groupIndex = page.startGroupIndex;
        groupIndex <= page.endGroupIndex;
        groupIndex++
      ) {
        const turnId = groupMeta[groupIndex]?.turnId;
        if (turnId) protectedTurnIds.add(turnId);
      }
      for (const turnId of getTurnIdsToLoadForPage(page, groupMeta)) {
        protectedTurnIds.add(turnId);
      }
    }

    for (const pageIndex of pageIndexes) {
      const page = pages[pageIndex];
      if (!page) continue;

      const turnIds = getTurnIdsToLoadForPage(page, groupMeta);
      for (const turnId of turnIds) {
        const loadKey = `${activeId}:${turnId}`;
        if (autoLoadedTurnKeysRef.current.has(loadKey)) continue;
        autoLoadedTurnKeysRef.current.add(loadKey);

        const startedForSession = activeId;

        void loadSessionTurnBodyIntoStore({
          sessionId: startedForSession,
          turnId,
        })
          .then(async () => {
            const replacedBoundedReplayBody = Boolean(
              resolveExternalReplayTarget(startedForSession)
            );
            if (replacedBoundedReplayBody) {
              autoLoadedTurnKeysRef.current.clear();
              autoLoadedTurnKeysRef.current.add(loadKey);
            }
            setLoadedTurnIds((prev) => {
              if (startedForSession !== activeId) return prev;
              if (replacedBoundedReplayBody) {
                return {
                  sessionId: startedForSession,
                  turnIds: new Set([turnId]),
                };
              }
              if (prev.sessionId !== startedForSession) {
                return {
                  sessionId: startedForSession,
                  turnIds: new Set([turnId]),
                };
              }
              if (prev.turnIds.has(turnId)) return prev;
              const next = new Set(prev.turnIds);
              next.add(turnId);
              return { sessionId: prev.sessionId, turnIds: next };
            });
            const prunedTurnIds = await pruneLoadedTurnBodies(
              startedForSession,
              protectedTurnIds
            );
            if (startedForSession !== activeId || prunedTurnIds.length === 0) {
              return;
            }
            for (const prunedTurnId of prunedTurnIds) {
              autoLoadedTurnKeysRef.current.delete(
                `${startedForSession}:${prunedTurnId}`
              );
            }
            setLoadedTurnIds((prev) => {
              if (prev.sessionId !== startedForSession) return prev;
              const next = new Set(prev.turnIds);
              for (const prunedTurnId of prunedTurnIds) {
                next.delete(prunedTurnId);
              }
              return { sessionId: prev.sessionId, turnIds: next };
            });
          })
          .catch((error: unknown) => {
            autoLoadedTurnKeysRef.current.delete(loadKey);
            logger.warn("Failed to lazy-load turn body", {
              sessionId: startedForSession,
              turnId,
              error,
            });
          });
      }
    }
  }, [
    activeId,
    currentPageIndex,
    groupMeta,
    pages,
    requiresExplicitTurnLoad,
    sessionLoadStatus,
    turnPaginationEnabled,
  ]);

  const selectTurnPage = useCallback(
    (pageIndex: number) => {
      setTurnPageSelection({
        pageIndex: pageIndex >= pageCount - 1 ? null : pageIndex,
        sessionId: activeId,
      });
      setTurnPageListOpen(false);
    },
    [activeId, pageCount, setTurnPageSelection, setTurnPageListOpen]
  );

  const handlePreviousTurnPage = useCallback(() => {
    setTurnPageSelection({
      pageIndex: Math.max(0, currentPageIndex - 1),
      sessionId: activeId,
    });
  }, [activeId, currentPageIndex, setTurnPageSelection]);

  const handleNextTurnPage = useCallback(() => {
    const nextPageIndex = Math.min(pageCount - 1, currentPageIndex + 1);
    setTurnPageSelection({
      pageIndex: nextPageIndex >= pageCount - 1 ? null : nextPageIndex,
      sessionId: activeId,
    });
  }, [activeId, currentPageIndex, pageCount, setTurnPageSelection]);

  const handleLastTurnPage = useCallback(() => {
    setTurnPageSelection({
      pageIndex: null,
      sessionId: activeId,
    });
  }, [activeId, setTurnPageSelection]);

  // Readiness gate. The rule has been narrowed three times to fix three
  // distinct deadlocks / flashes:
  //
  // 1. (Original) waited for EVERY group's `unloadedTurn` placeholder to
  //    clear. The prefetch effect only loads current ± 1, so any session
  //    with > ~3 turn pages spun the round selector forever and disabled
  //    every navigation button.
  //
  // 2. (Loaded-turn fix) added `loadedTurnIds` to count "load attempted,
  //    returned empty" as done — `ownDbTurnLoader` short-circuits on an
  //    empty array so the placeholder never goes away on its own.
  //
  // 3. (This change) narrow the gate further to ONLY the page the user
  //    is currently viewing. Watching `currentPageIndex ± 1` caused the
  //    `TurnPaginationControls` to flash on every prev/next click: the
  //    newly-revealed neighbor was always unloaded for a few hundred ms,
  //    `turnPaginationReady` flipped to false, the spinner replaced the
  //    chevron, and every button disabled. The neighbor prefetch still
  //    runs in the background (see effect above), but it does not gate
  //    UI. Pages outside the current viewport surface their own
  //    per-turn placeholder body — that is the correct progress signal
  //    there, not a global spinner that disables navigation.
  //
  // Page count itself is stable across body loads: `buildTurnPages`
  // pages on `groupHeaders` (user messages) and last-group, not on
  // group counts, so an `unloadedTurn` group still gets its own page.
  // This means flipping ready early does not cause a "Round 1 → Round N"
  // label jump even though the original comment worried about that.
  const isTurnLoaded = useCallback(
    (turnId: string) => {
      if (loadedTurnIds.sessionId !== activeId) return false;
      return loadedTurnIds.turnIds.has(turnId);
    },
    [activeId, loadedTurnIds]
  );

  const currentPageHasUnloadedTurn =
    !requiresExplicitTurnLoad &&
    (() => {
      const page = pages[currentPageIndex];
      if (!page) return false;
      const turnIds = getTurnIdsToLoadForPage(page, groupMeta);
      return turnIds.some((turnId) => !isTurnLoaded(turnId));
    })();
  const turnPaginationReady =
    sessionLoadStatus === "loaded" &&
    pageCount > 0 &&
    !currentPageHasUnloadedTurn;

  const currentTurnPageLabel =
    !turnPaginationReady || currentPageIndex >= pageCount - 1
      ? t("common:pagination.latestRound")
      : t("common:pagination.round", { current: currentPageIndex + 1 });

  const currentTurnPageTimeLabel = useMemo(() => {
    const page = pages[currentPageIndex];
    if (!page) return "";
    if (page.replayTurnSummary) {
      return formatReplayTurnPageTimeLabel(page.replayTurnSummary);
    }
    return formatTurnPageTimeLabel(
      groupMeta.slice(page.startGroupIndex, page.endGroupIndex + 1)
    );
  }, [currentPageIndex, groupMeta, pages]);

  return {
    selectTurnPage,
    handlePreviousTurnPage,
    handleNextTurnPage,
    handleLastTurnPage,
    turnPaginationReady,
    currentTurnPageLabel,
    currentTurnPageTimeLabel,
  };
}
