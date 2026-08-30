/**
 * WorkStation Git Status Context
 *
 * Provides O(1) status lookup for files and folders during rendering.
 */
import { createContext } from "react";

import type { GitStatusContextValue } from "./types";

export const GitStatusContext = createContext<GitStatusContextValue>({
  statusMap: new Map(),
  folderStatusMap: new Map(),
  repoPath: null,
  isMultiRoot: false,
});
