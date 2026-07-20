/**
 * openFileInWorkStation — open a file as a Code Editor tab while keeping the
 * caller on the current route.
 *
 * Unlike {@link openFileInEditor}, which dispatches an `open-file-in-editor`
 * CustomEvent that ultimately fires `action-system-navigate` to
 * `/orgii/workstation/code`, this helper writes directly to the workstation
 * layout atom. That means:
 *
 *   - the file tab is added to the main pane and becomes active
 *   - the WorkStation dock is flipped to Code Editor
 *   - the station mode is flipped to `"my-station"` so the WorkStation is
 *     actually visible
 *   - the chat-panel slot is un-maximized so the WorkStation pane on the
 *     right is exposed (caller may have been viewing Settings full-width)
 *   - **no navigation occurs** — the current route (e.g. settings) stays put
 *
 * Use this from the Settings / Integrations surfaces, where the WorkStation
 * is already visible in the right pane and we want to act on a file without
 * yanking the user out of their current view.
 */
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { dockFilterAtom } from "@src/store/workstation";
import {
  createFileTab,
  openWorkstationTabAtom,
  presentedWorkstationWorkspaceKeyAtom,
} from "@src/store/workstation/tabs";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

export interface OpenFileInWorkStationOptions {
  /** 1-based line to reveal once the file is open. */
  line?: number;
  /** Start previewable files in rendered preview mode instead of raw editor mode. */
  defaultPreviewMode?: boolean;
}

/**
 * Open `path` as a Code Editor tab in the WorkStation pane. No-op when
 * `path` is empty. Does NOT navigate the React Router route.
 */
export function openFileInWorkStation(
  path: string,
  options?: OpenFileInWorkStationOptions
): void {
  const trimmed = path.trim();
  if (trimmed.length === 0) return;

  const store = getInstrumentedStore();
  store.set(stationModeAtom, "my-station");
  store.set(dockFilterAtom, "code");
  // If the chat-panel slot is maximized (covering the main area), un-maximize
  // it so the WorkStation pane on the right is actually visible. The caller's
  // current route (e.g. settings) is preserved.
  if (store.get(chatPanelMaximizedAtom)) {
    store.set(chatPanelMaximizedAtom, false);
  }

  const tab = createFileTab(trimmed, {
    targetLine: options?.line,
    defaultPreviewMode: options?.defaultPreviewMode,
  });
  const workspace = store.get(presentedWorkstationWorkspaceKeyAtom);
  store.set(openWorkstationTabAtom, { workspace, tab });
}
