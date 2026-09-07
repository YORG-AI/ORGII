/**
 * useProjectDataChanged — centralized project-data-changed event coordinator
 *
 * Instead of each hook registering its own Tauri event listener for
 * "orgii-data-changed", this module provides:
 *
 * 1. `useProjectDataChangedListener()` — call once at the app level to set up
 *    the single Tauri listener. Bumps a Jotai signal atom + invalidates the
 *    API read cache on every event.
 *
 * 2. `useProjectDataChanged(callback)` — subscribe to data-change notifications.
 *    Calls the callback whenever the signal atom changes.
 *
 * The Tauri event channel name "orgii-data-changed" is the wire format emitted
 * by the Rust backend and is not renamed here.
 */
import { listen } from "@tauri-apps/api/event";
import { atom, useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";

import {
  PROJECT_ROSTER_CHANGED_EVENT,
  PROJECT_STATUS_DEFINITIONS_CHANGED_EVENT,
  type ProjectStatusDefinitionsChangedPayload,
  invalidateProjectCache,
} from "@src/api/http/project";

export interface ProjectDataChange {
  projectSlug?: string;
  workItemId?: string;
  repoPath?: string;
  source?: string;
}

type ProjectDataChangedWirePayload =
  | {
      project_slug?: string;
      work_item_id?: string;
      repo_path?: string;
      source?: string;
    }
  | string
  | null;

export function parseProjectDataChange(
  payload: ProjectDataChangedWirePayload
): ProjectDataChange | null {
  if (!payload || typeof payload !== "object") return null;
  return {
    projectSlug: payload.project_slug,
    workItemId: payload.work_item_id,
    repoPath: payload.repo_path,
    source: payload.source,
  };
}

export function invalidateProjectDataChangeCaches(
  change: ProjectDataChange | null
): void {
  if (change?.projectSlug) {
    invalidateProjectCache(change.projectSlug);
    // Project summaries include mutable work-item counts and timestamps.
    invalidateProjectCache("__projects__");
    return;
  }
  // Legacy/unscoped events cannot be mapped safely to a slug. A repo path is
  // not a project-cache key, so passing it here would leave relevant entries
  // stale.
  invalidateProjectCache();
}

// Signal atom: bumped on every project-data-changed event.
// Subscribers read this to trigger their own refresh logic.
export const projectDataChangedSignalAtom = atom(0);
projectDataChangedSignalAtom.debugLabel = "projectDataChangedSignalAtom";

// Compatibility payload for consumers that still match filesystem repos.
// New project-store consumers should use projectDataChangedChangeAtom so they
// can filter on projectSlug/workItemId without translating a repo path.
export const projectDataChangedRepoPathAtom = atom<string | null>(null);
projectDataChangedRepoPathAtom.debugLabel = "projectDataChangedRepoPathAtom";

export const projectDataChangedChangeAtom = atom<ProjectDataChange | null>(
  null
);
projectDataChangedChangeAtom.debugLabel = "projectDataChangedChangeAtom";

/**
 * Changes only when the local project/member roster can differ. Keeping this
 * separate from `projectDataChangedSignalAtom` prevents comment and Work Item
 * traffic from fanning out into every project's member file.
 */
export const projectRosterChangedSignalAtom = atom(0);
projectRosterChangedSignalAtom.debugLabel = "projectRosterChangedSignalAtom";

/** Client-only invalidation version for the org-scoped status catalog. */
export const projectStatusDefinitionsVersionAtom = atom<
  Readonly<Record<string, number>>
>({});
projectStatusDefinitionsVersionAtom.debugLabel =
  "projectStatusDefinitionsVersionAtom";

/**
 * Sets up the single Tauri listener for "orgii-data-changed".
 * Call once at the ProjectManager layout level (or app level).
 */
export function useProjectDataChangedListener(): void {
  const bumpSignal = useSetAtom(projectDataChangedSignalAtom);
  const setRepoPath = useSetAtom(projectDataChangedRepoPathAtom);
  const setChange = useSetAtom(projectDataChangedChangeAtom);
  const bumpRosterSignal = useSetAtom(projectRosterChangedSignalAtom);
  const bumpStatusDefinitionsVersion = useSetAtom(
    projectStatusDefinitionsVersionAtom
  );

  useEffect(() => {
    const unlistenPromise = listen<ProjectDataChangedWirePayload>(
      "orgii-data-changed",
      (event) => {
        const payload = event.payload;
        const change = parseProjectDataChange(payload);

        invalidateProjectDataChangeCaches(change);
        setRepoPath(change?.repoPath ?? null);
        setChange(change);
        bumpSignal((prev) => prev + 1);
      }
    );
    const unlistenRosterPromise = listen(PROJECT_ROSTER_CHANGED_EVENT, () => {
      bumpRosterSignal((previous) => previous + 1);
    });
    const unlistenStatusDefinitionsPromise =
      listen<ProjectStatusDefinitionsChangedPayload>(
        PROJECT_STATUS_DEFINITIONS_CHANGED_EVENT,
        (event) => {
          const orgId = event.payload.org_id;
          if (!orgId) return;
          invalidateProjectCache(orgId);
          bumpStatusDefinitionsVersion((previous) => ({
            ...previous,
            [orgId]: (previous[orgId] ?? 0) + 1,
          }));
        }
      );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
      unlistenRosterPromise.then((unlisten) => unlisten());
      unlistenStatusDefinitionsPromise.then((unlisten) => unlisten());
    };
  }, [
    bumpRosterSignal,
    bumpSignal,
    bumpStatusDefinitionsVersion,
    setChange,
    setRepoPath,
  ]);
}

/**
 * Subscribe to project-data-changed events via the centralized signal.
 * The callback fires after the API cache has been invalidated.
 */
export function useProjectDataChanged(
  callback: (change: ProjectDataChange | null) => void,
  options?: { fireOnMount?: boolean }
): void {
  const signal = useAtomValue(projectDataChangedSignalAtom);
  const change = useAtomValue(projectDataChangedChangeAtom);
  const isFirstRender = useRef(true);
  const callbackRef = useRef(callback);
  const changeRef = useRef(change);
  const fireOnMount = options?.fireOnMount === true;

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    changeRef.current = change;
  }, [change]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      if (!fireOnMount) return;
    }
    callbackRef.current(changeRef.current);
  }, [signal, fireOnMount]);
}
