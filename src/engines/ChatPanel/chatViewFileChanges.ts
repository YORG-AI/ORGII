import type { CoreSessionSummary } from "@src/api/tauri/lineage";
import type { Session } from "@src/store/session";
import { getFileName } from "@src/util/file/pathUtils";

import type { FileChangesResult } from "./InputArea/components/CompactFileChanges";

function impactFileChanges(input: {
  filesChanged?: number;
  linesAdded?: number;
  linesRemoved?: number;
  touchedFiles?: readonly string[];
}): FileChangesResult | undefined {
  const touchedFiles = input.touchedFiles ?? [];
  const filesChanged = input.filesChanged ?? touchedFiles.length;
  const totalAdditions = input.linesAdded ?? 0;
  const totalDeletions = input.linesRemoved ?? 0;
  if (filesChanged === 0 && totalAdditions === 0 && totalDeletions === 0) {
    return undefined;
  }

  const displayPaths =
    touchedFiles.length > 0
      ? touchedFiles
      : Array.from(
          { length: filesChanged },
          (_unused, fileIndex) => `Changed file ${fileIndex + 1}`
        );
  const files = displayPaths.map((path, fileIndex) => ({
    path,
    fileName: getFileName(path),
    status: "M",
    additions: fileIndex === 0 ? totalAdditions : 0,
    deletions: fileIndex === 0 ? totalDeletions : 0,
    lineCount: fileIndex === 0 ? totalAdditions + totalDeletions : 0,
  }));

  return {
    files,
    totalAdditions,
    totalDeletions,
    stats: { added: 0, modified: filesChanged, deleted: 0 },
  };
}

function sourceImpactFileChanges(
  session: Session | undefined
): FileChangesResult | undefined {
  return impactFileChanges({
    filesChanged: session?.filesChanged,
    linesAdded: session?.linesAdded,
    linesRemoved: session?.linesRemoved,
    touchedFiles: session?.touchedFiles,
  });
}

function summaryImpactFileChanges(
  summary: CoreSessionSummary | null
): FileChangesResult | undefined {
  if (!summary) return undefined;
  return impactFileChanges({
    filesChanged: summary.filesChanged,
    linesAdded: summary.linesAdded,
    linesRemoved: summary.linesRemoved,
  });
}

export function resolveInitialFileChanges({
  currentSession,
  isCursorIde,
  isExternalHistory,
  orgtrackSummary,
}: {
  currentSession: Session | undefined;
  isCursorIde: boolean;
  isExternalHistory: boolean;
  orgtrackSummary: CoreSessionSummary | null;
}): FileChangesResult | undefined {
  return isCursorIde || isExternalHistory
    ? (summaryImpactFileChanges(orgtrackSummary) ??
        sourceImpactFileChanges(currentSession))
    : undefined;
}
