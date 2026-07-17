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

import { invalidateProjectCache } from "@src/api/http/project";

// Signal atom: bumped on every project-data-changed event.
// Subscribers read this to trigger their own refresh logic.
export const projectDataChangedSignalAtom = atom(0);
projectDataChangedSignalAtom.debugLabel = "projectDataChangedSignalAtom";

// Payload atom: stores the most recent repo_path from the event (if any).
// Kept as repoPath (not slug) because the Tauri event payload is a filesystem
// path matched against repo.path / repo.fs_uri in useAllRepoProjects.
export const projectDataChangedRepoPathAtom = atom<string | null>(null);
projectDataChangedRepoPathAtom.debugLabel = "projectDataChangedRepoPathAtom";

/**
 * Sets up the single Tauri listener for "orgii-data-changed".
 * Call once at the ProjectManager layout level (or app level).
 */
export function useProjectDataChangedListener(): void {
  const bumpSignal = useSetAtom(projectDataChangedSignalAtom);
  const setRepoPath = useSetAtom(projectDataChangedRepoPathAtom);

  useEffect(() => {
    const unlistenPromise = listen<{ repo_path?: string } | string>(
      "orgii-data-changed",
      (event) => {
        const payload = event.payload;
        const repoPath =
          typeof payload === "object" ? payload?.repo_path : undefined;

        invalidateProjectCache(repoPath);
        setRepoPath(repoPath ?? null);
        bumpSignal((prev) => prev + 1);
      }
    );

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [bumpSignal, setRepoPath]);
}

/**
 * Subscribe to project-data-changed events via the centralized signal.
 * The callback fires after the API cache has been invalidated.
 */
export function useProjectDataChanged(
  callback: () => void,
  options?: { fireOnMount?: boolean }
): void {
  const signal = useAtomValue(projectDataChangedSignalAtom);
  const isFirstRender = useRef(true);
  const callbackRef = useRef(callback);
  const fireOnMount = options?.fireOnMount === true;

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      if (!fireOnMount) return;
    }
    callbackRef.current();
  }, [signal, fireOnMount]);
}
