import { atom } from "jotai";
import { RESET, atomWithStorage } from "jotai/utils";

import {
  CREATOR_COMPOSER_POSITION,
  type CreatorComposerPosition,
} from "@src/config/sessionCreatorConfig";

import { creatorComposerPositionAtom } from "./creatorComposerPositionAtom";

export const CREATOR_REPO_CHROME_POSITION_STORAGE_KEY =
  "orgii:sessionCreator:repoChromePosition";

export type CreatorRepoChromePosition = "top" | "bottom";

function normalizeCreatorRepoChromePosition(
  value: unknown
): CreatorRepoChromePosition | null {
  return value === "top" || value === "bottom" ? value : null;
}

const storedCreatorRepoChromePositionAtom = atomWithStorage<unknown>(
  CREATOR_REPO_CHROME_POSITION_STORAGE_KEY,
  null,
  undefined,
  { getOnInit: true }
);

/**
 * Global creator preference for the repository/branch/location chrome.
 *
 * Without an explicit choice, the trail sits above a bottom input and below
 * a centered input. Changing input placement resets any explicit trail choice.
 * The header and native context menus share the override until that change.
 * Skills/actions rows have their own placement and do not follow this setting.
 */
export const creatorRepoChromePositionAtom = atom(
  (get) =>
    normalizeCreatorRepoChromePosition(
      get(storedCreatorRepoChromePositionAtom)
    ) ??
    (get(creatorComposerPositionAtom) === CREATOR_COMPOSER_POSITION.MIDDLE
      ? "bottom"
      : "top"),
  (_get, set, position: CreatorRepoChromePosition) =>
    set(storedCreatorRepoChromePositionAtom, position)
);

/** Apply the input selection and its default trail position in one update. */
export const changeCreatorComposerPositionAtom = atom(
  null,
  (get, set, position: CreatorComposerPosition) => {
    if (get(creatorComposerPositionAtom) === position) return;
    set(creatorComposerPositionAtom, position);
    set(storedCreatorRepoChromePositionAtom, RESET);
  }
);
