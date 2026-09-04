/**
 * Spotlight Model Key-First Atom
 *
 * Which way round the two-column model palette runs:
 *
 * - `false` (default) — Step 1 pick a model, Step 2 pick a key for it.
 * - `true`            — Step 1 pick a key, Step 2 pick a model that key serves.
 *
 * Toggled from the "Key first" checkbox in the palette's keyboard-hint
 * footer (the same slot as the workspace palette's "Show path").
 * Persisted so the choice survives reopening the palette and restarting
 * the app.
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

const SPOTLIGHT_MODEL_KEY_FIRST_STORAGE_KEY = "orgii-spotlight-model-key-first";

const storedSpotlightModelKeyFirstAtom = atomWithStorage<unknown>(
  SPOTLIGHT_MODEL_KEY_FIRST_STORAGE_KEY,
  false,
  undefined,
  { getOnInit: true }
);

export const spotlightModelKeyFirstAtom = atom(
  (get) => get(storedSpotlightModelKeyFirstAtom) === true,
  (_get, set, keyFirst: boolean) =>
    set(storedSpotlightModelKeyFirstAtom, keyFirst)
);
spotlightModelKeyFirstAtom.debugLabel = "spotlightModelKeyFirstAtom";
