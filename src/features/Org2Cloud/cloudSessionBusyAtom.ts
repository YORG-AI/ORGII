/**
 * Per-row busy registry for cloud remote-session actions (replay / fork).
 *
 * Store-level rather than hook state on purpose: two sidebar connectors are
 * mounted at once whenever the hover sidebar is open, and Kanban's Take Over
 * button runs its own `useCloudSessionActions` instance — every surface must
 * agree on what is in flight, and a busy row must stay busy across a
 * connector remount mid-download.
 *
 * Keyed by the remote row id (`RemoteTeammateSessionMetadata.id`). Busy-ness
 * is per row, not global: one session downloading must not swallow clicks on
 * every other Team Sessions row. Replay entries learn the local
 * imported-session id as soon as it is derived, so a click on a busy row can
 * refocus the already-open Chat Pane tab instead of dying silently.
 */
import { atom } from "jotai";

export interface CloudSessionBusyEntry {
  kind: "replay" | "fork";
  orgId: string;
  /** Local session id the replay writes into; set once derived. */
  localSessionId?: string;
}

export const cloudSessionBusyRowsAtom = atom<
  ReadonlyMap<string, CloudSessionBusyEntry>
>(new Map());
cloudSessionBusyRowsAtom.debugLabel = "org2cloud/busySessionRows";

export const beginCloudSessionBusyAtom = atom(
  null,
  (get, set, payload: { rowId: string; entry: CloudSessionBusyEntry }) => {
    const next = new Map(get(cloudSessionBusyRowsAtom));
    next.set(payload.rowId, payload.entry);
    set(cloudSessionBusyRowsAtom, next);
  }
);
beginCloudSessionBusyAtom.debugLabel = "org2cloud/beginSessionBusy";

/** Merge fields (typically the derived localSessionId) into a live entry. */
export const updateCloudSessionBusyAtom = atom(
  null,
  (
    get,
    set,
    payload: { rowId: string; patch: Partial<CloudSessionBusyEntry> }
  ) => {
    const current = get(cloudSessionBusyRowsAtom);
    const entry = current.get(payload.rowId);
    if (!entry) return;
    const next = new Map(current);
    next.set(payload.rowId, { ...entry, ...payload.patch });
    set(cloudSessionBusyRowsAtom, next);
  }
);
updateCloudSessionBusyAtom.debugLabel = "org2cloud/updateSessionBusy";

export const endCloudSessionBusyAtom = atom(null, (get, set, rowId: string) => {
  const current = get(cloudSessionBusyRowsAtom);
  if (!current.has(rowId)) return;
  const next = new Map(current);
  next.delete(rowId);
  set(cloudSessionBusyRowsAtom, next);
});
endCloudSessionBusyAtom.debugLabel = "org2cloud/endSessionBusy";
