/**
 * Per-session narrowed subscriptions over the download-surface atoms.
 *
 * The raw atoms hold whole maps that get a new identity on every throttled
 * progress tick; subscribing to them from list rows or the chat pane
 * re-renders every consumer for every session's ticks. These hooks select
 * one session's slice with identity equality, so only surfaces showing THAT
 * session re-render — everything else sees a stable reference.
 */
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useMemo } from "react";

import {
  type CloudPendingPlay,
  cloudDownloadPendingPlayAtom,
} from "./cloudSessionDownloadControlAtoms";
import {
  type CloudSessionDownloadProgress,
  cloudSessionDownloadProgressAtom,
} from "./cloudSessionDownloadProgressAtom";

export function useCloudSessionDownloadProgressEntry(
  sessionId: string | null | undefined
): CloudSessionDownloadProgress | undefined {
  const entryAtom = useMemo(
    () =>
      selectAtom(cloudSessionDownloadProgressAtom, (map) =>
        sessionId ? map.get(sessionId) : undefined
      ),
    [sessionId]
  );
  return useAtomValue(entryAtom);
}

export function useCloudSessionPendingPlayEntry(
  sessionId: string | null | undefined
): CloudPendingPlay | undefined {
  const entryAtom = useMemo(
    () =>
      selectAtom(cloudDownloadPendingPlayAtom, (map) =>
        sessionId ? map.get(sessionId) : undefined
      ),
    [sessionId]
  );
  return useAtomValue(entryAtom);
}

/**
 * True while the session owns a download surface — pending play, live
 * transfer, paused, or the completed linger. The chat pane's empty/loading
 * branches must yield to the surface: a paused fresh download has zero
 * local events, and the confirmed-empty placeholder would otherwise evict
 * the paused card into a bewildering "No activity yet".
 */
export function useCloudSessionHasDownloadSurface(
  sessionId: string | null | undefined
): boolean {
  const hasAtom = useMemo(
    () =>
      selectAtom(cloudSessionDownloadProgressAtom, (map) =>
        sessionId ? map.has(sessionId) : false
      ),
    [sessionId]
  );
  const hasPendingAtom = useMemo(
    () =>
      selectAtom(cloudDownloadPendingPlayAtom, (map) =>
        sessionId ? map.has(sessionId) : false
      ),
    [sessionId]
  );
  const hasProgress = useAtomValue(hasAtom);
  const hasPending = useAtomValue(hasPendingAtom);
  return hasProgress || hasPending;
}
