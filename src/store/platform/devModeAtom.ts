import { atomWithStorage } from "jotai/utils";

/**
 * Dev Mode is opt-in and defaults to off.
 *
 * Storage key is `:v2` because the original `orgii:devModeEnabled` shipped
 * with a `true` default — every existing install has that persisted, and a
 * stored value always wins over the new default. Bumping the key abandons the
 * stale `true` so the off-by-default state actually reaches existing users;
 * anyone who wants Dev Mode re-enables it in Settings → General.
 */
export const devModeEnabledAtom = atomWithStorage<boolean>(
  "orgii:devModeEnabled:v2",
  false,
  undefined,
  { getOnInit: true }
);
devModeEnabledAtom.debugLabel = "devModeEnabledAtom";
