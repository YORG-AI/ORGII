/**
 * Git Status Badge Component
 *
 * Shared component for displaying git status indicators.
 * - Directories: Show colored dot
 * - Files: Show status letter (M, A, D, R, U)
 */
import React from "react";

import {
  getStatusBgColor,
  getStatusColorForFile,
  getStatusLetterForFile,
} from "@src/config/gitStatus";

import type { GitStatusBadgeProps } from "./types";

export const GitStatusBadge: React.FC<GitStatusBadgeProps> = React.memo(
  ({ status, isDirectory, title }) => {
    if (!status) {
      return null;
    }

    if (isDirectory) {
      return (
        <div className="flex h-4 w-5 shrink-0 items-center justify-center">
          <div
            className={`h-1.5 w-1.5 rounded-full ${getStatusBgColor(status.status)}`}
            title={title ?? `Contains ${status.status} files`}
          />
        </div>
      );
    }

    const statusLetter = getStatusLetterForFile(status.status, status.staged);
    const colorClass = getStatusColorForFile(status.status, status.staged);

    return (
      <div className="flex h-4 w-5 shrink-0 items-center justify-center">
        <span
          className={`text-[12px] font-medium ${colorClass}`}
          title={
            title ??
            `Git status: ${status.status}${status.staged ? " (staged)" : ""}`
          }
        >
          {statusLetter}
        </span>
      </div>
    );
  }
);

GitStatusBadge.displayName = "GitStatusBadge";

export default GitStatusBadge;
