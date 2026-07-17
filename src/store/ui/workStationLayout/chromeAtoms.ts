import { atom } from "jotai";

import { getStoredValue, setStoredValue } from "./storage";

function getStoredTitleBarHidden(): boolean {
  const stored = getStoredValue("title_bar_hidden");
  return stored === "true";
}

export const workStationTitleBarHiddenAtom = atom<boolean>(
  getStoredTitleBarHidden()
);
workStationTitleBarHiddenAtom.debugLabel = "workStationTitleBarHiddenAtom";

export const workStationTitleBarHiddenPersistAtom = atom(
  (get) => get(workStationTitleBarHiddenAtom),
  (_get, set, value: boolean) => {
    set(workStationTitleBarHiddenAtom, value);
    setStoredValue("title_bar_hidden", String(value));
  }
);

function getStoredStatusBarHidden(): boolean {
  const stored = getStoredValue("status_bar_hidden");
  return stored === "true";
}

export const workStationStatusBarHiddenAtom = atom<boolean>(
  getStoredStatusBarHidden()
);
workStationStatusBarHiddenAtom.debugLabel = "workStationStatusBarHiddenAtom";

export const workStationStatusBarHiddenPersistAtom = atom(
  (get) => get(workStationStatusBarHiddenAtom),
  (_get, set, value: boolean) => {
    set(workStationStatusBarHiddenAtom, value);
    setStoredValue("status_bar_hidden", String(value));
  }
);

/** Agent Station chrome frame: steady border normally, breathing light while follow/play is active. Default on. */
export const workStationFollowAgentHighlightEnabledAtom = atom<boolean>(true);
workStationFollowAgentHighlightEnabledAtom.debugLabel =
  "workStationFollowAgentHighlightEnabledAtom";

export const workStationFollowAgentHighlightPersistAtom = atom(
  (get) => get(workStationFollowAgentHighlightEnabledAtom),
  (_get, set, value: boolean) => {
    set(workStationFollowAgentHighlightEnabledAtom, value);
    setStoredValue("follow_agent_highlight", String(value));
  }
);
