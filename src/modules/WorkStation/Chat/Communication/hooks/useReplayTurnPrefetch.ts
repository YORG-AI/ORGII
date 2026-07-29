/**
 * Forward-prefetch of unloaded turn bodies ahead of the replay cursor in
 * the Workstation Communication ("Messages") surface.
 *
 * `UnloadedTurnBubble` (../ChatBubble/UnloadedTurnBubble.tsx) already fetches
 * a turn's body once its placeholder chunk mounts — but that's reactive, not
 * predictive: the very first frame a placeholder scrolls into view still
 * shows the "Loading message…" spinner while the fetch is in flight. During
 * continuous playback (auto-advancing the cursor, or a fast manual scrub)
 * that beat repeats on every cold round.
 *
 * This hook warms the next few DISTINCT unloaded turns *before* the cursor
 * reaches them, using the same load/prune primitives `UnloadedTurnBubble`
 * uses, so by the time playback gets there the body is usually already
 * resident.
 */
import { useAtomValue } from "jotai";
import { useEffect, useRef } from "react";

import { transcriptReplaceEpochAtom } from "@src/engines/SessionCore/core/atoms/metadata";
import {
  getMountedTurnPlaceholderIds,
  loadSessionTurnBodyIntoStore,
  pruneLoadedTurnBodies,
} from "@src/engines/SessionCore/turns";
import { REPLAY_TURN_PREFETCH_AHEAD } from "@src/engines/SessionCore/turns/turnWindowConfig";
import { createLogger } from "@src/hooks/logger";
import {
  isCodexAppSession,
  isImportedHistorySession,
} from "@src/util/session/sessionDispatch";

import type { CommunicationUnloadedTurnMeta } from "../types";

const log = createLogger("ReplayTurnPrefetch");

/**
 * Minimal shape the pure selection logic needs from an ordered transcript
 * entry. A full `MessageEntry` satisfies this structurally — callers don't
 * need to build a separate lightweight list unless they want to avoid the
 * cost of full message-content extraction over the whole (unwindowed)
 * session transcript.
 */
export interface ReplayPrefetchEntry {
  eventId: string;
  unloadedTurn?: CommunicationUnloadedTurnMeta | null;
}

/**
 * Forward-prefetch radius for a session. Codex app imports keep radius 0
 * deliberately: `MAX_LOADED_CODEX_HISTORICAL_TURN_BODIES` caps Codex to a
 * single resident turn body (its source loader does real file I/O per
 * fetch — see `codexAppTurnLoader.ts`), so prefetching ahead would evict
 * the round currently on screen the instant the fetch lands, trading the
 * "Loading message…" beat this hook exists to eliminate for a new one.
 * Every other imported-history provider tolerates
 * `MAX_LOADED_HISTORICAL_TURN_BODIES` resident bodies, so a small forward
 * radius is safe there.
 */
export function getReplayPrefetchRadius(
  sessionId: string | null | undefined
): number {
  return isCodexAppSession(sessionId) ? 0 : REPLAY_TURN_PREFETCH_AHEAD;
}

/**
 * Pure selection: walk forward from just after `cursorIndex` and collect up
 * to `radius` DISTINCT unloaded turn ids, skipping entries whose body is
 * already loaded (`unloadedTurn` unset) and de-duping repeated turnIds (a
 * single unloaded turn's placeholder can span more than one flattened
 * entry).
 *
 * Returns `[]` when `radius` is non-positive, the cursor is unknown
 * (`cursorIndex < 0`), or nothing unloaded remains between the cursor and
 * the end of the list.
 */
export function selectUnloadedTurnIdsAheadOfCursor(
  entries: ReadonlyArray<ReplayPrefetchEntry>,
  cursorIndex: number,
  radius: number
): string[] {
  if (radius <= 0 || cursorIndex < 0) return [];

  const turnIds: string[] = [];
  const seen = new Set<string>();
  for (
    let index = cursorIndex + 1;
    index < entries.length && turnIds.length < radius;
    index++
  ) {
    const turnId = entries[index]?.unloadedTurn?.turnId;
    if (!turnId || seen.has(turnId)) continue;
    seen.add(turnId);
    turnIds.push(turnId);
  }
  return turnIds;
}

/**
 * The unloaded turn "at or nearest" the cursor, scanning backward from
 * `cursorIndex` (inclusive). This hook's own `pruneLoadedTurnBodies` call
 * only knows about the turns it just prefetched — without this, it could
 * evict the round the user is actually looking at (or one
 * `UnloadedTurnBubble`'s own mount effect is still fetching) purely because
 * that turn is older than the prefetched ones in the load-time ordering
 * `pruneLoadedTurnBodies` sorts by.
 */
export function findNearestUnloadedTurnId(
  entries: ReadonlyArray<ReplayPrefetchEntry>,
  cursorIndex: number
): string | null {
  if (cursorIndex < 0 || entries.length === 0) return null;
  const start = Math.min(cursorIndex, entries.length - 1);
  for (let index = start; index >= 0; index--) {
    const turnId = entries[index]?.unloadedTurn?.turnId;
    if (turnId) return turnId;
  }
  return null;
}

export interface UseReplayTurnPrefetchOptions {
  /** Active session id. Hook is a no-op for anything but imported history. */
  sessionId: string | null | undefined;
  /**
   * Ordered transcript entries for the WHOLE session (not windowed to the
   * replay cursor) — the cursor only gates what's *rendered*; every turn's
   * placeholder/loaded state is already known once a session is opened, so
   * scanning ahead of the cursor here doesn't reveal spoilers, it just
   * warms cache.
   */
  entries: ReadonlyArray<ReplayPrefetchEntry>;
  /** Index of the current replay cursor within `entries`, or -1 if unknown. */
  cursorIndex: number;
}

/**
 * Fire-and-forget forward prefetch. Mirrors the precedent prefetch effect
 * in `useTurnPageNavigation`
 * (src/engines/ChatPanel/ChatHistory/hooks/useTurnPageSelection.ts): a
 * `${sessionId}:${turnId}` fired-key ref dedups repeat effect runs, cleared
 * whenever the session changes or a windowed replace reload bumps
 * `transcriptReplaceEpochAtom` (bodies a replace drops back to placeholders
 * need to be eligible for refetch again). A failed load deletes its own
 * fired key and logs a warning instead of throwing — an unhandled
 * rejection here would escalate to the fatal full-screen error page.
 */
export function useReplayTurnPrefetch({
  sessionId,
  entries,
  cursorIndex,
}: UseReplayTurnPrefetchOptions): void {
  const firedKeysRef = useRef<Set<string>>(new Set());
  const transcriptReplaceEpoch = useAtomValue(transcriptReplaceEpochAtom);

  useEffect(() => {
    firedKeysRef.current.clear();
  }, [sessionId, transcriptReplaceEpoch]);

  useEffect(() => {
    if (!sessionId || !isImportedHistorySession(sessionId)) return;
    const activeSessionId = sessionId;

    const radius = getReplayPrefetchRadius(activeSessionId);
    const turnIdsToLoad = selectUnloadedTurnIdsAheadOfCursor(
      entries,
      cursorIndex,
      radius
    );
    if (turnIdsToLoad.length === 0) return;

    const protectedTurnIds = new Set(turnIdsToLoad);
    const nearestTurnId = findNearestUnloadedTurnId(entries, cursorIndex);
    if (nearestTurnId) protectedTurnIds.add(nearestTurnId);

    for (const turnId of turnIdsToLoad) {
      const fireKey = `${activeSessionId}:${turnId}`;
      if (firedKeysRef.current.has(fireKey)) continue;
      firedKeysRef.current.add(fireKey);

      void loadSessionTurnBodyIntoStore({ sessionId: activeSessionId, turnId })
        .then(async () => {
          // Union the prefetch-radius protection with every placeholder
          // that's actually mounted on screen right now (read fresh at
          // prune time, not captured when this effect ran — mounts/unmounts
          // can happen while this fetch is in flight). Otherwise this
          // prefetch's prune call can evict a body an `UnloadedTurnBubble`
          // is currently relying on purely because it's older by load
          // timestamp. See mountedTurnPlaceholders.ts.
          const protectedIds = new Set(protectedTurnIds);
          for (const mountedTurnId of getMountedTurnPlaceholderIds(
            activeSessionId
          )) {
            protectedIds.add(mountedTurnId);
          }
          await pruneLoadedTurnBodies(activeSessionId, protectedIds);
        })
        .catch((error: unknown) => {
          // Fire-and-forget: a failed forward-prefetch must never surface as
          // an unhandled rejection. Deleting the fired key lets a later
          // effect run (e.g. the cursor moving again) retry it; if the
          // cursor reaches this turn before that happens,
          // `UnloadedTurnBubble`'s own mount effect still fetches it —
          // this hook is an optimization, not the only path to the body.
          firedKeysRef.current.delete(fireKey);
          log.warn(`Replay forward-prefetch failed for turn ${turnId}:`, error);
        });
    }
  }, [sessionId, entries, cursorIndex, transcriptReplaceEpoch]);
}

export default useReplayTurnPrefetch;
