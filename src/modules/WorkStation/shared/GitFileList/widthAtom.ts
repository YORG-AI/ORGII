/**
 * Shared width for the "changed files" column that accompanies `GitFileList`.
 *
 * Persisted to localStorage so the user's preferred column width carries
 * across every place that renders a file-list + diff-viewer pair (e.g.
 * `GitCommitDetailContent` in Workstation > Code Editor > git commit
 * detail).
 */
import { atomWithStorage } from "jotai/utils";

export const GIT_FILE_LIST_MIN_WIDTH = 180;
export const GIT_FILE_LIST_MAX_WIDTH = 520;
export const GIT_FILE_LIST_DEFAULT_WIDTH = 180;

export const gitFileListWidthAtom = atomWithStorage<number>(
  "orgii:gitFileListWidth",
  GIT_FILE_LIST_DEFAULT_WIDTH
);
