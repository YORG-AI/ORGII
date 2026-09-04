import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export const PINNED_ACTIONS_VISIBLE_STORAGE_KEY =
  "orgii:sessionCreator:pinnedActionsVisible";

function normalizePinnedActionsVisible(value: unknown): boolean {
  return typeof value === "boolean" ? value : false;
}

const storedPinnedActionsVisibleAtom = atomWithStorage<unknown>(
  PINNED_ACTIONS_VISIBLE_STORAGE_KEY,
  false,
  undefined,
  { getOnInit: true }
);

/**
 * Shared composer preference for showing pinned quick-action pills and their
 * management controls in the Session Creator and active sessions. Pinned
 * actions are hidden by default until the user opts in.
 *
 * The preference does not delete or unpin actions. Compact and hidden-repo
 * creator surfaces ignore it because they do not expose the native menu that
 * can restore visibility.
 */
export const pinnedActionsVisibleAtom = atom(
  (get) => normalizePinnedActionsVisible(get(storedPinnedActionsVisibleAtom)),
  (_get, set, visible: boolean) => set(storedPinnedActionsVisibleAtom, visible)
);
