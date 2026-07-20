/**
 * CompactFileChanges
 *
 * Headless tracker for file-change stats shown in the composer files pill.
 * It intentionally renders no UI: clicking the pill opens Agent Station Diff.
 */
import { useAtomValue } from "jotai";
import React, { memo, useEffect, useMemo } from "react";

import { useChatSessionId } from "@src/engines/ChatPanel/ChatSessionContext";
import { sessionIdAtom } from "@src/engines/SessionCore";

import {
  EMPTY_FILE_CHANGE_SUMMARY,
  type FileChangeSummary,
  type FileChangesResult,
  resolveFileChangeSummary,
} from "./compactFileChangesHelpers";
import { useCompactFileData } from "./useCompactFileData";

export type {
  FileChangeInfo,
  FileChangesResult,
} from "./compactFileChangesHelpers";

export type FileChangeVisibleStats = FileChangeSummary;

interface CompactFileChangesProps {
  /** Explicit session owner for composer surfaces that may render under a different chat context. */
  sessionIdOverride?: string | null;
  /** When provided, uses this static data instead of fetching from the session. */
  initialData?: FileChangesResult;
  /**
   * Idle-reload signal forwarded to the data hook so the pill refetches the
   * orgtrack snapshot when a round completes / the agent goes idle, instead of
   * only on session switch.
   */
  reloadKey?: string;
  /** Reports file stats to the parent pill. */
  onVisibleStatsChange?: (stats: FileChangeVisibleStats) => void;
}

const CompactFileChanges: React.FC<CompactFileChangesProps> = memo(
  ({ sessionIdOverride, initialData, reloadKey, onVisibleStatsChange }) => {
    const contextSessionId = useChatSessionId();
    const globalSessionId = useAtomValue(sessionIdAtom);
    const sessionId = sessionIdOverride ?? contextSessionId ?? globalSessionId;

    const { allFiles } = useCompactFileData({
      sessionId,
      initialData,
      reloadKey,
    });

    const visibleStats = useMemo<FileChangeVisibleStats>(() => {
      if (allFiles.length === 0) return EMPTY_FILE_CHANGE_SUMMARY;
      return resolveFileChangeSummary(allFiles, initialData);
    }, [allFiles, initialData]);

    useEffect(() => {
      onVisibleStatsChange?.(visibleStats);
    }, [visibleStats, onVisibleStatsChange]);

    return null;
  }
);

CompactFileChanges.displayName = "CompactFileChanges";

export default CompactFileChanges;
