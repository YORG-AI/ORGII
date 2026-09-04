import { atom } from "jotai";

import { getStoredValue } from "./storage";

function getStoredTitleBarHidden(): boolean {
  const stored = getStoredValue("title_bar_hidden");
  return stored === "true";
}

export const workStationTitleBarHiddenAtom = atom<boolean>(
  getStoredTitleBarHidden()
);
workStationTitleBarHiddenAtom.debugLabel = "workStationTitleBarHiddenAtom";

function getStoredStatusBarHidden(): boolean {
  const stored = getStoredValue("status_bar_hidden");
  return stored === "true";
}

export const workStationStatusBarHiddenAtom = atom<boolean>(
  getStoredStatusBarHidden()
);
workStationStatusBarHiddenAtom.debugLabel = "workStationStatusBarHiddenAtom";

/** Agent Station chrome frame: steady border normally, breathing light while follow/play is active. Default on. */
export const workStationFollowAgentHighlightEnabledAtom = atom<boolean>(true);
workStationFollowAgentHighlightEnabledAtom.debugLabel =
  "workStationFollowAgentHighlightEnabledAtom";
