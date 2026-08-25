/**
 * EditorStatusBarRight
 *
 * Right cluster of the CodeEditor status bar: last commit, cursor position
 * and selection, and total lines. Presentational only — every value is
 * passed in.
 */
import type { TFunction } from "i18next";
import { GitCommit } from "lucide-react";
import React from "react";

import { StatusBarSegment, StatusBarText } from "../StatusBarBase";
import type { CommitInfo, CursorPosition } from "../types";

export interface EditorStatusBarRightProps {
  t: TFunction;
  commitInfo: CommitInfo | null | undefined;
  cursor: CursorPosition | null;
  /**
   * Intentionally not narrowed to `boolean`: the caller computes this as
   * `cursor?.selectedChars && cursor.selectedChars > 0`, so it can also be
   * `0` or `undefined`. Coercing here would change what gets rendered.
   */
  hasSelection: number | boolean | undefined;
  totalLines: number | undefined;
}

export const EditorStatusBarRight: React.FC<EditorStatusBarRightProps> = ({
  t,
  commitInfo,
  cursor,
  hasSelection,
  totalLines,
}) => (
  <>
    {commitInfo && (
      <StatusBarSegment
        title={`${commitInfo.message}\n\n${commitInfo.author} · ${commitInfo.shortSha}`}
        className="text-text-1"
      >
        <GitCommit size={13} />
        <span className="max-w-[200px] truncate">{commitInfo.author}</span>
        <span className="text-text-3">·</span>
        <span className="text-text-3">{commitInfo.time}</span>
      </StatusBarSegment>
    )}

    {cursor && (
      <StatusBarText numeric>
        Ln {cursor.line}, Col {cursor.column}
      </StatusBarText>
    )}

    {hasSelection && (
      <StatusBarText numeric>
        (
        {cursor?.selectedLines && cursor.selectedLines > 1
          ? t("workstation.linesSelected", {
              count: cursor.selectedLines,
            })
          : t("workstation.charsSelected", {
              count: cursor?.selectedChars ?? 0,
            })}
        )
      </StatusBarText>
    )}

    {totalLines !== undefined && (
      <StatusBarText numeric>
        {t("workstation.nLines", { count: totalLines })}
      </StatusBarText>
    )}
  </>
);

EditorStatusBarRight.displayName = "EditorStatusBarRight";
