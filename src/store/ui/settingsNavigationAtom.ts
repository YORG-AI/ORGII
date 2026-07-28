import { atom } from "jotai";

/** Last WorkStation URL to restore when the user leaves Settings. */
export const settingsReturnPathAtom = atom<string | null>(null);
settingsReturnPathAtom.debugLabel = "settingsReturnPathAtom";
