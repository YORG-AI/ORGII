import type { ReactNode } from "react";

import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";

import type { PrResolveMeta } from "./worktreeSmartInput";

export interface GitHubWorktreeItem {
  id: string;
  icon: ReactNode;
  source: WorktreeLaunchSource;
  detail: string;
  searchableText: string;
  pr?: PrResolveMeta;
}
