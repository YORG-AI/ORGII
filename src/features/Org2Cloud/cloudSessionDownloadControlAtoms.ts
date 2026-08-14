/**
 * Control-plane state for interactive cloud session downloads.
 *
 * Three small registries replace the old modal gate:
 * - `cloudDownloadPendingPlayAtom` — big sessions no longer auto-download.
 *   The replay click opens the Chat Pane tab and parks a pending-play entry
 *   (event count + ETA); the pane renders a play card and nothing transfers
 *   until the user hits Start.
 * - `cloudSessionPausedDownloadsAtom` — the progress surface's Pause button
 *   aborts the transfer WITHOUT rolling back persisted pages. The captured
 *   cursor (epoch / last persisted frozen seq / persisted count) lets the
 *   next start continue from where it stopped via the incremental streamer;
 *   a null cursor (nothing persisted, assembled path, refresh pause) simply
 *   restreams from scratch.
 * - `cloudDownloadStartRequestAtom` — the pane cards cannot call the
 *   replay hook directly; they park a start request that the mounted
 *   sidebar section consumes (same idiom as the auto-replay reveal).
 */
import { atom } from "jotai";

export interface CloudPausedDownloadCursor {
  epoch: number;
  seq: number;
  count: number;
  frozenCount: number;
}

export interface CloudPausedDownload {
  localSessionId: string;
  orgId: string;
  /** Server-reported total at pause time; drives the paused card's percent. */
  totalEvents: number | null;
  loadedEvents: number;
  /** null ⇒ nothing resumable persisted; the next start restreams fully. */
  cursor: CloudPausedDownloadCursor | null;
}

/** Keyed by remote row id (`RemoteTeammateSessionMetadata.id`). */
export const cloudSessionPausedDownloadsAtom = atom<
  ReadonlyMap<string, CloudPausedDownload>
>(new Map());
cloudSessionPausedDownloadsAtom.debugLabel = "org2cloud/pausedDownloads";

export const setCloudPausedDownloadAtom = atom(
  null,
  (get, set, payload: { rowId: string; entry: CloudPausedDownload }) => {
    const next = new Map(get(cloudSessionPausedDownloadsAtom));
    next.set(payload.rowId, payload.entry);
    set(cloudSessionPausedDownloadsAtom, next);
  }
);
setCloudPausedDownloadAtom.debugLabel = "org2cloud/setPausedDownload";

export const clearCloudPausedDownloadAtom = atom(
  null,
  (get, set, rowId: string) => {
    const current = get(cloudSessionPausedDownloadsAtom);
    if (!current.has(rowId)) return;
    const next = new Map(current);
    next.delete(rowId);
    set(cloudSessionPausedDownloadsAtom, next);
  }
);
clearCloudPausedDownloadAtom.debugLabel = "org2cloud/clearPausedDownload";

export interface CloudPendingPlay {
  rowId: string;
  orgId: string;
  /** Canonical source icon shown before a local replay row exists. */
  iconId: string;
  /** Safe remote workspace/branch labels retained until a local row exists. */
  sessionEnvironment?: CloudSessionEnvironmentIdentity;
  /** Events the download would actually fetch (listing count minus covered). */
  pendingEvents: number;
  etaMs: number;
  /**
   * What Start resumes: a read-only replay or a Take Over pre-import. Both
   * ride the same card/progress surface; the start-request consumer routes
   * by this.
   */
  kind: "replay" | "fork";
}

export interface CloudSessionEnvironmentIdentity {
  repoName?: string;
  branchName?: string;
  baseBranchName?: string;
  worktreeBranchName?: string;
}

/** Keyed by the LOCAL imported-session id (the Chat Pane tab's key). */
export const cloudDownloadPendingPlayAtom = atom<
  ReadonlyMap<string, CloudPendingPlay>
>(new Map());
cloudDownloadPendingPlayAtom.debugLabel = "org2cloud/pendingPlay";

export const setCloudDownloadPendingPlayAtom = atom(
  null,
  (get, set, payload: { localSessionId: string; entry: CloudPendingPlay }) => {
    const next = new Map(get(cloudDownloadPendingPlayAtom));
    next.set(payload.localSessionId, payload.entry);
    set(cloudDownloadPendingPlayAtom, next);
  }
);
setCloudDownloadPendingPlayAtom.debugLabel = "org2cloud/setPendingPlay";

export const clearCloudDownloadPendingPlayAtom = atom(
  null,
  (get, set, localSessionId: string) => {
    const current = get(cloudDownloadPendingPlayAtom);
    if (!current.has(localSessionId)) return;
    const next = new Map(current);
    next.delete(localSessionId);
    set(cloudDownloadPendingPlayAtom, next);
  }
);
clearCloudDownloadPendingPlayAtom.debugLabel = "org2cloud/clearPendingPlay";

export interface CloudDownloadStartRequest {
  requestId: number;
  rowId: string;
  orgId: string;
  kind: "replay" | "fork";
}

/** Single-slot: a newer request replaces an unconsumed older one. */
export const cloudDownloadStartRequestAtom =
  atom<CloudDownloadStartRequest | null>(null);
cloudDownloadStartRequestAtom.debugLabel = "org2cloud/downloadStartRequest";
