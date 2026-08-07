/**
 * DatabaseStatusBar
 *
 * Status bar for Database Manager showing:
 * - Repository and branch info
 * - Sidebar toggle (via callbacks atom)
 *
 * Uses BaseStatusBar for consistent layout.
 */
import { Code, Database, GitBranch } from "lucide-react";
import React, { memo, useMemo } from "react";

import { BaseStatusBar, StatusBarButton } from "./StatusBarBase";

export interface DatabaseStatusBarProps {
  /** Repository name */
  repoName?: string;
  /** Current branch name */
  branchName?: string;
  /** Callback when repo button is clicked */
  onRepoClick?: () => void;
  /** Callback when branch button is clicked */
  onBranchClick?: () => void;
  className?: string;
}

const DatabaseStatusBar: React.FC<DatabaseStatusBarProps> = memo(
  ({ repoName, branchName, onRepoClick, onBranchClick, className }) => {
    const leftContent = useMemo(
      () => (
        <>
          {repoName && (
            <StatusBarButton onClick={onRepoClick} title={`Repo: ${repoName}`}>
              <Code size={13} className="text-text-1" />
              <span className="font-medium text-text-1">{repoName}</span>
            </StatusBarButton>
          )}

          {branchName && (
            <StatusBarButton
              onClick={onBranchClick}
              title={`Branch: ${branchName}`}
            >
              <GitBranch size={13} className="text-text-1" />
              <span className="font-medium text-text-1">{branchName}</span>
            </StatusBarButton>
          )}
        </>
      ),
      [repoName, branchName, onRepoClick, onBranchClick]
    );

    const rightContent = useMemo(
      () => (
        <StatusBarButton title="Database Manager">
          <Database size={13} className="text-text-1" />
        </StatusBarButton>
      ),
      []
    );

    return (
      <BaseStatusBar
        leftContent={leftContent}
        rightContent={rightContent}
        roundedBottom={false}
        className={className}
      />
    );
  }
);

DatabaseStatusBar.displayName = "DatabaseStatusBar";

export default DatabaseStatusBar;
