import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

// Shared by session/local branch pickers, like the Show path preference.
// Only the view preference persists; PR data remains owned by the open picker.
const storedShowBranchInfoAtom = atomWithStorage<unknown>(
  "orgii-spotlight-show-branch-info",
  false,
  undefined,
  { getOnInit: true }
);

export const spotlightShowBranchInfoAtom = atom(
  (get) => get(storedShowBranchInfoAtom) === true,
  (_get, set, visible: boolean) => set(storedShowBranchInfoAtom, visible)
);
spotlightShowBranchInfoAtom.debugLabel = "spotlightShowBranchInfoAtom";
