import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

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
 * `null` preserves each creator layout's established first-run position. Once
 * the user chooses a position, the explicit value is persisted across app
 * restarts and shared by every Session Creator entry point.
 */
export const creatorRepoChromePositionAtom = atom(
  (get) =>
    normalizeCreatorRepoChromePosition(
      get(storedCreatorRepoChromePositionAtom)
    ),
  (_get, set, position: CreatorRepoChromePosition) =>
    set(storedCreatorRepoChromePositionAtom, position)
);

export function resolveCreatorRepoChromePosition(
  preference: CreatorRepoChromePosition | null,
  fallback: CreatorRepoChromePosition
): CreatorRepoChromePosition {
  return preference ?? fallback;
}
