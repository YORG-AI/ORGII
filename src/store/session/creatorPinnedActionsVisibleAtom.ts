import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export const PINNED_ACTIONS_VISIBLE_STORAGE_KEY =
  "orgii:sessionCreator:pinnedActionsVisible";
/** @deprecated Use `PINNED_ACTIONS_VISIBLE_STORAGE_KEY`. */
export const CREATOR_PINNED_ACTIONS_VISIBLE_STORAGE_KEY =
  PINNED_ACTIONS_VISIBLE_STORAGE_KEY;

function normalizePinnedActionsVisible(value: unknown): boolean {
  return typeof value === "boolean" ? value : true;
}

const storedPinnedActionsVisibleAtom = atomWithStorage<unknown>(
  PINNED_ACTIONS_VISIBLE_STORAGE_KEY,
  true,
  undefined,
  { getOnInit: true }
);

/**
 * Shared composer preference for showing pinned quick-action pills and their
 * management controls in the Session Creator and active sessions.
 *
 * The preference does not delete or unpin actions. Compact and hidden-repo
 * creator surfaces ignore it because they do not expose the native menu that
 * can restore visibility.
 */
export const pinnedActionsVisibleAtom = atom(
  (get) => normalizePinnedActionsVisible(get(storedPinnedActionsVisibleAtom)),
  (_get, set, visible: boolean) => set(storedPinnedActionsVisibleAtom, visible)
);

/** @deprecated Use `pinnedActionsVisibleAtom`. */
export const creatorPinnedActionsVisibleAtom = pinnedActionsVisibleAtom;
