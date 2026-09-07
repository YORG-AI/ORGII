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

import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

import {
  type CloudPendingPlay,
  cloudDownloadPendingPlayAtom,
} from "./cloudSessionDownloadControlAtoms";
import {
  type CloudSessionDownloadProgress,
  cloudSessionDownloadProgressAtom,
} from "./cloudSessionDownloadProgressAtom";
import {
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "./org2CloudAuthAtom";

function useCurrentCloudAuthIdentityKey(): string | null {
  const auth = useAtomValue(org2CloudAuthAtom);
  return auth ? org2CloudAuthIdentityKey(auth) : null;
}

export function useCloudSessionDownloadProgressEntry(
  sessionId: string | null | undefined
): CloudSessionDownloadProgress | undefined {
  const authIdentityKey = useCurrentCloudAuthIdentityKey();
  const entryAtom = useMemo(
    () =>
      selectAtom(cloudSessionDownloadProgressAtom, (map) => {
        const entry = sessionId ? map.get(sessionId) : undefined;
        return entry?.authIdentityKey === authIdentityKey ? entry : undefined;
      }),
    [authIdentityKey, sessionId]
  );
  return useAtomValue(entryAtom);
}

export function useCloudSessionPendingPlayEntry(
  sessionId: string | null | undefined
): CloudPendingPlay | undefined {
  const authIdentityKey = useCurrentCloudAuthIdentityKey();
  const entryAtom = useMemo(
    () =>
      selectAtom(cloudDownloadPendingPlayAtom, (map) => {
        const entry = sessionId ? map.get(sessionId) : undefined;
        return entry?.authIdentityKey === authIdentityKey ? entry : undefined;
      }),
    [authIdentityKey, sessionId]
  );
  return useAtomValue(entryAtom);
}

/** Source metadata visible before a local imported Session row exists. */
export function useCloudSessionLoadingSource(
  sessionId: string | null | undefined
): RemoteTeammateSessionMetadata | undefined {
  const progress = useCloudSessionDownloadProgressEntry(sessionId);
  const pending = useCloudSessionPendingPlayEntry(sessionId);
  return progress?.sourceSession ?? pending?.sourceSession;
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
  const authIdentityKey = useCurrentCloudAuthIdentityKey();
  const hasAtom = useMemo(
    () =>
      selectAtom(cloudSessionDownloadProgressAtom, (map) => {
        const entry = sessionId ? map.get(sessionId) : undefined;
        return entry?.authIdentityKey === authIdentityKey;
      }),
    [authIdentityKey, sessionId]
  );
  const hasPendingAtom = useMemo(
    () =>
      selectAtom(cloudDownloadPendingPlayAtom, (map) => {
        const entry = sessionId ? map.get(sessionId) : undefined;
        return entry?.authIdentityKey === authIdentityKey;
      }),
    [authIdentityKey, sessionId]
  );
  const hasProgress = useAtomValue(hasAtom);
  const hasPending = useAtomValue(hasPendingAtom);
  return hasProgress || hasPending;
}
