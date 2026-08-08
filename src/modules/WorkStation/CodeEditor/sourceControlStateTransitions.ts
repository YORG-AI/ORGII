import type { PanelState } from "@src/store/workstation/tabs";

export type SourceControlMainMode = "focus" | "all-changes";

/**
 * Remember the last changed file the user inspected without leaving the current
 * Source Control mode. All Changes uses this as the hand-off target when the
 * user later switches to Focus.
 */
export function rememberSourceControlFocusPath(
  state: PanelState,
  focusPath: string
): PanelState {
  const tabIndex = state.tabs.findIndex(
    (item) => item.type === "source-control"
  );
  if (tabIndex === -1) return state;

  const existing = state.tabs[tabIndex];
  if (existing.data.focusPath === focusPath) return state;

  const nextTabs = [...state.tabs];
  nextTabs[tabIndex] = {
    ...existing,
    data: {
      ...existing.data,
      focusPath,
    },
  };

  return { ...state, tabs: nextTabs };
}

/**
 * Switch the Source Control main surface while retaining its remembered file.
 * History detail is mutually exclusive with the Focus / All Changes surfaces.
 */
export function setSourceControlMainMode(
  state: PanelState,
  mode: SourceControlMainMode
): PanelState {
  const tabIndex = state.tabs.findIndex(
    (item) => item.type === "source-control"
  );
  if (tabIndex === -1) return state;

  const existing = state.tabs[tabIndex];
  if (existing.data.mode === mode && !existing.data.historySelection) {
    return state;
  }

  const nextTabs = [...state.tabs];
  nextTabs[tabIndex] = {
    ...existing,
    data: {
      ...existing.data,
      mode,
      historySelection: null,
    },
  };

  return { ...state, tabs: nextTabs };
}
