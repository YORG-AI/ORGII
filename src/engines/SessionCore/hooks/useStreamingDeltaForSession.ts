/**
 * useStreamingDeltaForSession
 *
 * Subscribe to a single session's live streaming delta instead of the whole
 * `streamingDeltaContentAtom` Map.
 *
 * The Map's identity changes on every ≤20Hz flush (see streamingDeltaBuffer),
 * so `useAtomValue(streamingDeltaContentAtom)` re-renders EVERY subscriber on
 * every flush — including already-completed rows and rows for sessions that
 * are not the one streaming. That is the "streaming re-renders the whole list"
 * hot path: N mounted bubbles/rows × 20Hz.
 *
 * This narrows the subscription to one session's slice with a value-equality
 * guard, so a component only re-renders when *its* session's delta actually
 * changes (i.e. the live row). For any other session the selected value stays
 * `null` across flushes → equal → no re-render.
 *
 * The derived atom is memoized per `sessionId` via `useMemo` and is garbage
 * collected when the component unmounts, so there is no per-session atomFamily
 * to leak.
 */
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useMemo } from "react";

import {
  type StreamingDeltaContent,
  streamingDeltaContentAtom,
} from "@src/engines/SessionCore/core/atoms";

function streamingDeltaEqual(
  a: StreamingDeltaContent | null,
  b: StreamingDeltaContent | null
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.kind === b.kind && a.content === b.content;
}

export function useStreamingDeltaForSession(
  sessionId: string | null | undefined
): StreamingDeltaContent | null {
  const deltaAtom = useMemo(
    () =>
      selectAtom(
        streamingDeltaContentAtom,
        (map) => (sessionId ? (map.get(sessionId) ?? null) : null),
        streamingDeltaEqual
      ),
    [sessionId]
  );
  return useAtomValue(deltaAtom);
}

export default useStreamingDeltaForSession;
