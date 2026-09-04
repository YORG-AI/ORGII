import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export const CREATOR_LAUNCHPAD_ACTIONS_VISIBLE_STORAGE_KEY =
  "orgii:sessionCreator:launchpadActionsVisible";

function normalizeCreatorLaunchpadActionsVisible(value: unknown): boolean {
  return typeof value === "boolean" ? value : true;
}

const storedCreatorLaunchpadActionsVisibleAtom = atomWithStorage<unknown>(
  CREATOR_LAUNCHPAD_ACTIONS_VISIBLE_STORAGE_KEY,
  true,
  undefined,
  { getOnInit: true }
);

/**
 * Whether the launchpad's quick-action group is shown. The preference only
 * changes presentation; it does not disable any of the underlying actions.
 */
export const creatorLaunchpadActionsVisibleAtom = atom(
  (get) =>
    normalizeCreatorLaunchpadActionsVisible(
      get(storedCreatorLaunchpadActionsVisibleAtom)
    ),
  (_get, set, visible: boolean) =>
    set(storedCreatorLaunchpadActionsVisibleAtom, visible)
);

creatorLaunchpadActionsVisibleAtom.debugLabel =
  "creatorLaunchpadActionsVisibleAtom";
