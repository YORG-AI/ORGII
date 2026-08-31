/**
 * Spotlight Show Path Atom
 *
 * Whether workspace and worktree rows in the spotlight render their
 * filesystem path under the name. Off by default — the path is noise for
 * users whose repos all live in one folder — and toggled from the
 * "Show path" pill next to the spotlight's keyboard-hint footer.
 *
 * Persisted so the choice survives reopening the palette and restarting
 * the app.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

const SPOTLIGHT_SHOW_PATH_STORAGE_KEY = "orgii-spotlight-show-path";

const storedSpotlightShowPathAtom = atomWithStorage<unknown>(
  SPOTLIGHT_SHOW_PATH_STORAGE_KEY,
  false,
  undefined,
  { getOnInit: true }
);

export const spotlightShowPathAtom = atom(
  (get) => get(storedSpotlightShowPathAtom) === true,
  (_get, set, visible: boolean) => set(storedSpotlightShowPathAtom, visible)
);
spotlightShowPathAtom.debugLabel = "spotlightShowPathAtom";
