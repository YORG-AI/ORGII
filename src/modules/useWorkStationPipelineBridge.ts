/**
 * useWorkStationPipelineBridge
 *
 * Keeps the live "pipeline" atom (`activeSessionIdAtom`) in sync with
 * WorkStation's remembered selection (`workstationActiveSessionIdAtom`)
 * whenever WorkStation is the visible view.
 *
 * Two scenarios this covers:
 *
 *   1. View transition INTO WorkStation: a secondary surface (kanban
 *      detail panel, project-manager tab, etc.) may have temporarily
 *      claimed the pipeline atom to render some other session's chat.
 *      On return to WorkStation, restore pipeline = memory so the
 *      docked ChatPanel and SessionSyncProvider point at the
 *      session WorkStation actually wants to show.
 *
 *   2. Memory change WHILE the user is in WorkStation: any caller
 *      that writes `workstationActiveSessionIdAtom` directly
 *      (ActionSystem, scripted nav, programmatic open) will have
 *      its change reflected in the live pipeline without needing to
 *      remember to write both atoms.
 *
 * Owner sites (sidebar click, tab change, launch flow) write both
 * atoms eagerly so the chat updates in lockstep with the navigation;
 * this bridge is the safety net for everything else.
 *
 * Extracted into its own hook so it can be unit-tested against a
 * vanilla Jotai store without instantiating the full AppShell tree.
 */
import { useAtomValue, useStore } from "jotai";
import { useEffect } from "react";

import {
  activeSessionIdAtom,
  workstationActiveSessionIdAtom,
} from "@src/store/session";
import { subscribeToAtoms } from "@src/util/core/state/subscribeToAtoms";

/**
 * Minimal store interface used by the bridge so the same production
 * subscription lifecycle can be tested with a vanilla Jotai store.
 */
export type PipelineBridgeStore = Pick<
  ReturnType<typeof import("jotai/vanilla").createStore>,
  "get" | "set" | "sub"
>;

/**
 * Pure, sync logic of the bridge — extracted so it can be exercised
 * directly in unit tests against a `createStore()` instance. Returns
 * `true` if the pipeline was updated, `false` if the bridge no-oped.
 */
export function applyWorkStationPipelineBridge(
  isWorkStationViewActive: boolean,
  remembered: string | null,
  store: PipelineBridgeStore
): boolean {
  if (!isWorkStationViewActive) return false;
  const pipeline = store.get(activeSessionIdAtom);
  if (remembered === pipeline) return false;
  store.set(activeSessionIdAtom, remembered);
  return true;
}

/**
 * Keep the WorkStation invariant alive for the whole visible-session
 * lifecycle, not only when the view or remembered selection changes.
 *
 * A secondary ChatView can finish unmounting after the primary session tab
 * has already reclaimed the same pipeline. Its stale cleanup writes `null`
 * without changing WorkStation memory. Subscribing to both sides lets the
 * bridge repair that late write immediately while avoiding a React render for
 * every pipeline transition.
 */
export function installWorkStationPipelineBridge(
  isWorkStationViewActive: boolean,
  store: PipelineBridgeStore
): () => void {
  if (!isWorkStationViewActive) return () => undefined;

  const reconcile = () => {
    applyWorkStationPipelineBridge(
      true,
      store.get(workstationActiveSessionIdAtom),
      store
    );
  };

  // Subscribe before the initial reconciliation so no write can land in the
  // gap between reading the remembered selection and installing the guard.
  const unsubscribe = subscribeToAtoms(
    store,
    [workstationActiveSessionIdAtom, activeSessionIdAtom],
    reconcile
  );
  reconcile();

  return unsubscribe;
}

export function useWorkStationPipelineBridge(
  isWorkStationViewActive: boolean
): void {
  const store = useStore();
  // Keep the persisted memory atom hydrated before the imperative bridge
  // subscription mounts. This preserves the cold-start ordering guaranteed by
  // the previous hook while pipeline-only changes stay outside React renders.
  useAtomValue(workstationActiveSessionIdAtom);
  useEffect(
    () => installWorkStationPipelineBridge(isWorkStationViewActive, store),
    [isWorkStationViewActive, store]
  );
}
