/**
 * useCodeEditorLocalState — Local UI state and status-bar sync for CodeEditor.
 *
 * Extracted to keep CodeEditor/index.tsx under the 600-line limit.
 * Owns: cursor position, total-line count, and the file-scoped half of the
 * status bar (cursor, path, commit tab). Workspace/branch identity and the
 * repo/branch/worktree spotlight buttons are NOT pushed from here — the status
 * bar outlives this host, which unmounts on the empty Launchpad, so it reads
 * them from the global workspace/repo atoms instead.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";

import { codeStatusBarStateAtom } from "@src/store/ui/workStationAtom";
import {
  activeWorkStationFilePathAtom,
  activeWorkStationTabAtom,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";
import type { PanelState } from "@src/store/workstation/tabs";
import { isPreviewOnlyFile } from "@src/util/file/previewTypes";
import { formatRelativeTime } from "@src/util/time/formatRelativeTime";

import type { CommitInfo, CursorPosition } from "../shared";
import { useCodeEditor } from "./hooks/useCodeEditor";

// ── Types ─────────────────────────────────────────────────────────────────────

interface UseCodeEditorLocalStateOptions {
  isActive: boolean;
  codeEditorState: ReturnType<typeof useCodeEditor>;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useCodeEditorLocalState({
  isActive,
  codeEditorState,
}: UseCodeEditorLocalStateOptions) {
  // ── UI state ──────────────────────────────────────────────────────────────

  const [searchPanelVisible, setSearchPanelVisible] = useState(false);
  const [cursorPosition, setCursorPosition] = useState<CursorPosition | null>(
    null
  );

  // ── Layout: single main pane ─────────────────────────────────────────────

  const setLayout = useSetAtom(workstationLayoutAtom);

  const setPrimaryPanel = useCallback(
    (updater: unknown) => {
      setLayout((prev) => ({
        ...prev,
        mainPane: (updater as (prev: PanelState) => PanelState)(
          prev?.mainPane ?? { tabs: [], activeTabId: null }
        ),
      }));
    },
    [setLayout]
  );

  // ── Active tab info ───────────────────────────────────────────────────────

  const focusedActiveTab = useAtomValue(activeWorkStationTabAtom);
  const focusedActiveFilePath = useAtomValue(activeWorkStationFilePathAtom);

  const activeCommitSha =
    focusedActiveTab?.type === "git-diff" && focusedActiveTab.data.isTimeline
      ? (focusedActiveTab.data.commitSha as string)
      : null;

  const statusBarCommitInfo: CommitInfo | null = useMemo(() => {
    if (
      focusedActiveTab?.type === "git-diff" &&
      focusedActiveTab.data.isTimeline
    ) {
      const { commitMessage, commitAuthor, commitTimestamp } =
        focusedActiveTab.data;
      if (commitMessage && commitAuthor && commitTimestamp) {
        return {
          message: String(commitMessage),
          author: String(commitAuthor),
          time: formatRelativeTime(String(commitTimestamp), "compact"),
          shortSha: String(focusedActiveTab.data.headShortSha || ""),
        };
      }
    }
    return null;
  }, [focusedActiveTab]);

  // ── Cursor + total-line tracking ─────────────────────────────────────────

  const handleCursorPositionChange = useCallback(
    (position: CursorPosition | null) => {
      setCursorPosition(position);
    },
    []
  );

  const totalLines = useMemo(
    () =>
      codeEditorState.fileContent
        ? codeEditorState.fileContent.split("\n").length
        : undefined,
    [codeEditorState.fileContent]
  );

  const handleSymbolClick = useCallback((line: number) => {
    window.dispatchEvent(
      new CustomEvent("editor-go-to-line", { detail: { line } })
    );
  }, []);

  const handleAllChangesClick = useCallback(() => {
    // TODO: Implement show all changes
  }, []);

  // ── Status bar sync effects ───────────────────────────────────────────────

  const setGlobalStatusBarState = useSetAtom(codeStatusBarStateAtom);

  const isPreviewOnly =
    !!focusedActiveFilePath && isPreviewOnlyFile(focusedActiveFilePath);

  useEffect(() => {
    if (!isActive) return;
    setGlobalStatusBarState((prev) => ({
      ...prev,
      appType: "code" as const,
      cursor: focusedActiveFilePath && !isPreviewOnly ? cursorPosition : null,
      filePath: isPreviewOnly ? null : focusedActiveFilePath,
      totalLines:
        focusedActiveFilePath && !isPreviewOnly ? totalLines : undefined,
      commitInfo: statusBarCommitInfo,
    }));
  }, [
    cursorPosition,
    focusedActiveFilePath,
    isPreviewOnly,
    totalLines,
    statusBarCommitInfo,
    isActive,
    setGlobalStatusBarState,
  ]);

  return {
    // State
    searchPanelVisible,
    setSearchPanelVisible,
    cursorPosition,
    // Layout
    setPrimaryPanel,
    // Tab info
    activeCommitSha,
    focusedActiveFilePath,
    focusedActiveTab,
    // Handlers
    handleCursorPositionChange,
    handleSymbolClick,
    handleAllChangesClick,
  };
}
