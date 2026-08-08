/**
 * Shared width for the "changed files" column that accompanies `GitFileList`.
 *
 * Persisted to localStorage so the user's preferred column width carries
 * across every place that renders a file-list + diff-viewer pair (e.g.
 * `GitCommitDetailContent` in Workstation > Code Editor > git commit
 * detail).
 */
import { atom } from "jotai";
import { atomWithStorage } from "jotai/utils";

export const GIT_FILE_LIST_MIN_WIDTH = 200;
export const GIT_FILE_LIST_MAX_WIDTH = 520;
export const GIT_FILE_LIST_DEFAULT_WIDTH = 200;

const persistedGitFileListWidthAtom = atomWithStorage<number>(
  "orgii:gitFileListWidth",
  GIT_FILE_LIST_DEFAULT_WIDTH
);

function clampGitFileListWidth(width: number): number {
  return Math.max(
    GIT_FILE_LIST_MIN_WIDTH,
    Math.min(GIT_FILE_LIST_MAX_WIDTH, width)
  );
}

/**
 * Clamp reads as well as writes so an older persisted 180px preference cannot
 * bypass the new minimum before the user next drags the resize handle.
 */
export const gitFileListWidthAtom = atom(
  (get) => clampGitFileListWidth(get(persistedGitFileListWidthAtom)),
  (_get, set, width: number) => {
    set(persistedGitFileListWidthAtom, clampGitFileListWidth(width));
  }
);
