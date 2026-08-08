import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

import type { DiffViewMode } from "@src/types/git/types";

export const DIFF_VIEW_MODE_STORAGE_KEY = "orgii:gitDiffViewMode";
export const DEFAULT_DIFF_VIEW_MODE: DiffViewMode = "unified";

export function normalizeDiffViewMode(value: unknown): DiffViewMode {
  return value === "split" ? "split" : DEFAULT_DIFF_VIEW_MODE;
}

const persistedDiffViewModeAtom = atomWithStorage<unknown>(
  DIFF_VIEW_MODE_STORAGE_KEY,
  DEFAULT_DIFF_VIEW_MODE
);

/**
 * Authoritative diff presentation preference shared by working-tree, commit,
 * pull-request, aggregate, and replay diff surfaces.
 */
export const diffViewModeAtom = atom(
  (get) => normalizeDiffViewMode(get(persistedDiffViewModeAtom)),
  (_get, set, mode: DiffViewMode) => {
    set(persistedDiffViewModeAtom, mode);
  }
);
diffViewModeAtom.debugLabel = "codeEditor/diffViewMode";
