/**
 * Creator default product mode atom
 *
 * Persists the session creator's composer-mode selection on the PRODUCT
 * axis (orgtrack/v1 §5.2). Only the `project` selection is stored — the
 * plain exec modes (`build`/`plan`/`ask`) live in
 * `creatorDefaultExecModeAtom`, and `project` additionally derives
 * `build` there. Launch reads this atom to stamp `productMode` on the
 * new session so it boots inside the persistent work graph.
 */
import { atomWithStorage } from "jotai/utils";

import { PRODUCT_MODE_PROJECT } from "@src/config/sessionCreatorConfig";

const STORAGE_KEY = "orgii:creatorProductMode";

export type CreatorDefaultProductMode = typeof PRODUCT_MODE_PROJECT | null;

const storage = {
  getItem(
    key: string,
    initialValue: CreatorDefaultProductMode
  ): CreatorDefaultProductMode {
    if (typeof window === "undefined") return initialValue;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored == null) return initialValue;
      return JSON.parse(stored) === PRODUCT_MODE_PROJECT
        ? PRODUCT_MODE_PROJECT
        : null;
    } catch {
      return initialValue;
    }
  },
  setItem(key: string, value: CreatorDefaultProductMode) {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, JSON.stringify(value));
  },
  removeItem(key: string) {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(key);
  },
};

export const creatorDefaultProductModeAtom =
  atomWithStorage<CreatorDefaultProductMode>(STORAGE_KEY, null, storage);
