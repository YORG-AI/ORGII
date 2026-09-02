import React, { memo } from "react";

import type { CommitDiffResult } from "@src/api/http/git/types";

interface CommitInfoPanelProps {
  commitDiff: CommitDiffResult;
  hasInlineHeaderAbove?: boolean;
}

/**
 * The fixed-height info strip rendered below the file list / diff header.
 */
export const CommitInfoPanel: React.FC<CommitInfoPanelProps> = memo(
  function CommitInfoPanel({ commitDiff, hasInlineHeaderAbove = false }) {
    const paddingClassName = hasInlineHeaderAbove ? "pb-3" : "pb-3 pt-3";

    return (
      <div
        className={`max-h-40 shrink-0 overflow-hidden border-b border-border-2 px-3 ${paddingClassName}`}
      >
        {commitDiff.body ? (
          <div className="scrollbar-overlay max-h-[148px] overflow-y-auto pr-2">
            <p className="max-w-[860px] cursor-text text-[12px] leading-5 whitespace-pre-wrap text-text-2 select-text">
              {commitDiff.body}
            </p>
          </div>
        ) : null}
      </div>
    );
  }
);
