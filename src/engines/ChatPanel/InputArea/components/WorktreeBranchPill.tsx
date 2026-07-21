/**
 * WorktreeBranchPill — read-only worktree + branch indicator for the composer
 * status bar. Rendered in the center cluster between pills (model|effort) and
 * the context ring, mirroring Claude Code CLI's bottom cwd/branch line.
 */
import { useAtomValue } from "jotai";
import { Folder, GitBranch } from "lucide-react";
import React, { memo } from "react";

import { useRepoSelection } from "@src/hooks/git/useRepoSelection";
import { activeWorkspaceRootAtom } from "@src/store/workspace";

const WorktreeBranchPill: React.FC = memo(() => {
  const root = useAtomValue(activeWorkspaceRootAtom);
  const { currentBranch } = useRepoSelection({ autoLoad: false });

  const name = root?.name;
  const path = root?.path;
  const branch = currentBranch || undefined;

  if (!name && !branch) return null;

  return (
    <div
      className="flex h-[28px] min-w-0 max-w-full shrink items-center gap-1.5 rounded-full px-2 text-[12px] text-text-3"
      title={path ? `${path}${branch ? ` · ${branch}` : ""}` : branch}
    >
      {name && (
        <span className="flex min-w-0 items-center gap-1">
          <Folder size={13} strokeWidth={1.75} className="shrink-0" />
          <span className="truncate">{name}</span>
        </span>
      )}
      {name && branch && <span className="shrink-0 text-text-4">·</span>}
      {branch && (
        <span className="flex min-w-0 items-center gap-1">
          <GitBranch size={13} strokeWidth={1.75} className="shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      )}
    </div>
  );
});

WorktreeBranchPill.displayName = "WorktreeBranchPill";

export default WorktreeBranchPill;
