import type { OpenPRItem } from "@src/api/tauri/github";
import type { WorktreeLaunchSource } from "@src/store/session/worktreeLaunchSourceAtom";

import { compactText } from "./worktreeBranchSource";
import type { PrResolveMeta } from "./worktreeSmartInput";

export interface WorktreePrOption {
  id: string;
  source: WorktreeLaunchSource;
  detail: string;
  searchableText: string;
  resolveMeta: PrResolveMeta;
}

/** Map an open GitHub PR to the canonical worktree-source shape. */
export function prToWorktreeOption(pr: OpenPRItem): WorktreePrOption {
  const label = compactText(`#${pr.number} ${pr.title}`);
  const detail = `${pr.head_branch} -> ${pr.base_branch}`;
  return {
    id: `pr:${pr.number}`,
    source: {
      kind: "github",
      label,
      baseBranch: pr.head_branch || pr.base_branch,
      sourceRef: `pr:${pr.number}`,
      title: pr.title,
    },
    detail,
    searchableText: `${label} ${detail}`,
    resolveMeta: {
      prNumber: pr.number,
      headBranch: pr.head_branch || undefined,
      baseBranch: pr.base_branch || undefined,
    },
  };
}
