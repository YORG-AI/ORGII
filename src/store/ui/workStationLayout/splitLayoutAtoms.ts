import { atom } from "jotai";

import { getStoredValue, setStoredValue } from "./storage";

export type LayoutMode = "left" | "right";

function getStoredLayoutMode(): LayoutMode {
  const stored = getStoredValue("layout_mode");
  if (stored && ["left", "right"].includes(stored)) {
    return stored as LayoutMode;
  }
  return "left";
}

export const workStationLayoutModeAtom = atom<LayoutMode>(
  getStoredLayoutMode()
);
workStationLayoutModeAtom.debugLabel = "workStationLayoutModeAtom";

export const workStationLayoutModePersistAtom = atom(
  (get) => get(workStationLayoutModeAtom),
  (_get, set, value: LayoutMode) => {
    set(workStationLayoutModeAtom, value);
    setStoredValue("layout_mode", value);
  }
);
