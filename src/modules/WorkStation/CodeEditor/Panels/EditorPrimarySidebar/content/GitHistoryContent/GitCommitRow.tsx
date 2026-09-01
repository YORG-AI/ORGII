import React, { memo, useCallback } from "react";

import type { GitCommitInfo, GitCommitPerson } from "@src/api/http/git/types";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { useImmediateCursorReset } from "@src/hooks/ui/useImmediateCursorReset";
import { PRIMARY_SIDEBAR_HOVER } from "@src/modules/WorkStation/shared/tokens";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import type { CommitGraphNode } from "./graphLayout";
import { DOT_RADIUS, LANE_WIDTH } from "./graphLayout";

export const GIT_COMMIT_ROW_HEIGHT = 36;

interface GraphSvgProps {
  graphNode: CommitGraphNode;
  svgWidth: number;
  isFirst: boolean;
}

const GraphSvg: React.FC<GraphSvgProps> = memo(
  ({ graphNode, svgWidth, isFirst }) => {
    const centerY = GIT_COMMIT_ROW_HEIGHT / 2;
    const dotX = graphNode.lane * LANE_WIDTH + LANE_WIDTH / 2;

    return (
      <svg width={svgWidth} height={GIT_COMMIT_ROW_HEIGHT} className="shrink-0">
        {graphNode.lines.map((line, lineIndex) => {
          const fromX = line.fromLane * LANE_WIDTH + LANE_WIDTH / 2;
          const toX = line.toLane * LANE_WIDTH + LANE_WIDTH / 2;

          if (
            isFirst &&
            line.segment === "top" &&
            line.fromLane === graphNode.lane &&
            line.toLane === graphNode.lane
          ) {
            return null;
          }

          if (line.segment === "top") {
            return (
              <line
                key={`line-${lineIndex}`}
                x1={fromX}
                y1={0}
                x2={toX}
                y2={centerY}
                stroke={line.color}
                strokeWidth={1.5}
              />
            );
          }
          return (
            <line
              key={`line-${lineIndex}`}
              x1={fromX}
              y1={centerY}
              x2={toX}
              y2={GIT_COMMIT_ROW_HEIGHT}
              stroke={line.color}
              strokeWidth={1.5}
            />
          );
        })}
        <circle cx={dotX} cy={centerY} r={DOT_RADIUS} fill={graphNode.color} />
      </svg>
    );
  }
);

GraphSvg.displayName = "GitCommitRow.GraphSvg";

type GitCommitRowBaseCommit = Pick<
  GitCommitInfo,
  "sha" | "short_sha" | "summary"
> & {
  author?: GitCommitPerson | null;
};

export interface GitCommitRowProps<TCommit extends GitCommitRowBaseCommit> {
  commit: TCommit;
  isSelected: boolean;
  graphNode?: CommitGraphNode;
  svgWidth?: number;
  isFirst?: boolean;
  onSelect: (commit: TCommit) => void;
  onContextMenu?: (event: React.MouseEvent, commit: TCommit) => void;
  showGraphPlaceholder?: boolean;
}

function GitCommitRowComponent<TCommit extends GitCommitRowBaseCommit>({
  commit,
  isSelected,
  graphNode,
  svgWidth,
  isFirst = false,
  onSelect,
  onContextMenu,
  showGraphPlaceholder = false,
}: GitCommitRowProps<TCommit>) {
  const { cursorReset, markClicked, resetCursor } =
    useImmediateCursorReset(isSelected);

  const handleClick = useCallback(() => {
    markClicked();
    onSelect(commit);
  }, [commit, markClicked, onSelect]);

  const authorName = commit.author?.name ?? "Unknown";
  const authorDate = commit.author?.date ?? "";
  const graphWidth = svgWidth ?? LANE_WIDTH;

  return (
    <button
      type="button"
      className={`group flex w-full items-center gap-1 pr-3 pl-2 text-left transition-colors ${
        cursorReset || isSelected ? "cursor-default" : "cursor-pointer"
      } ${isSelected ? SURFACE_TOKENS.selected : PRIMARY_SIDEBAR_HOVER.row}`}
      style={{ height: `${GIT_COMMIT_ROW_HEIGHT}px` }}
      onClick={handleClick}
      onContextMenu={(event) => onContextMenu?.(event, commit)}
      onMouseLeave={resetCursor}
      title={`${commit.summary}\n\n${commit.short_sha} by ${authorName}`}
    >
      {graphNode && svgWidth ? (
        <GraphSvg graphNode={graphNode} svgWidth={svgWidth} isFirst={isFirst} />
      ) : showGraphPlaceholder ? (
        <span style={{ width: graphWidth }} className="shrink-0" />
      ) : null}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12px] leading-tight text-text-1">
            {commit.summary}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-text-3">
          <span className="truncate">{authorName}</span>
          {authorDate && (
            <span className="shrink-0">
              {formatRelativeTime(authorDate, "nano")}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

const GitCommitRow = memo(
  GitCommitRowComponent
) as typeof GitCommitRowComponent;

export default GitCommitRow;
