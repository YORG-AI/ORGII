import type { LineDiffStats } from "@src/util/diff/types";
import { getFileName, normalizeDiffFilePath } from "@src/util/file/pathUtils";

export interface FileChangeInfo {
  path: string;
  fileName: string;
  status: string;
  additions: number;
  deletions: number;
  lineCount: number;
}

export interface FileChangesResult {
  files: FileChangeInfo[];
  totalAdditions: number;
  totalDeletions: number;
  stats: { added: number; modified: number; deleted: number };
}

export interface FileChangeSummary extends LineDiffStats {
  count: number;
}

export const EMPTY_FILE_CHANGE_SUMMARY: Readonly<FileChangeSummary> =
  Object.freeze({ count: 0, additions: 0, deletions: 0 });

export function summarizeFileChanges(
  files: ReadonlyArray<FileChangeInfo>
): FileChangeSummary {
  return files.reduce<FileChangeSummary>(
    (summary, file) => ({
      count: summary.count + 1,
      additions: summary.additions + file.additions,
      deletions: summary.deletions + file.deletions,
    }),
    EMPTY_FILE_CHANGE_SUMMARY
  );
}

export function resolveFileChangeSummary(
  files: ReadonlyArray<FileChangeInfo>,
  aggregate?: Pick<FileChangesResult, "totalAdditions" | "totalDeletions">
): FileChangeSummary {
  if (aggregate) {
    return {
      count: files.length,
      additions: aggregate.totalAdditions,
      deletions: aggregate.totalDeletions,
    };
  }
  return summarizeFileChanges(files);
}

/** Minimal shape of an orgtrack final-diff record consumed by the pill. */
export interface FinalDiffLike {
  filePath: string;
  isDeleted?: boolean;
  linesAdded: number;
  linesRemoved: number;
}

export interface EditArtifactLike {
  filePath: string;
  editKind:
    | "read"
    | "write"
    | "delete"
    | "patch"
    | "commit_boundary"
    | "unknown";
  linesAdded: number;
  linesRemoved: number;
  sequenceIndex: number;
}

/**
 * Map a single orgtrack final-diff record to the pill's `FileChangeInfo`.
 * Pure so the composer pill's stats math stays unit-testable.
 */
export function mapFinalDiffToFileChangeInfo(
  finalDiff: FinalDiffLike
): FileChangeInfo {
  const normalizedPath = normalizeDiffFilePath(finalDiff.filePath);
  return {
    path: normalizedPath,
    fileName: getFileName(normalizedPath),
    status: finalDiff.isDeleted ? "D" : "M",
    additions: finalDiff.linesAdded,
    deletions: finalDiff.linesRemoved,
    lineCount: finalDiff.linesAdded + finalDiff.linesRemoved,
  };
}

export function mapEditArtifactsToFileChangeInfo(
  artifacts: ReadonlyArray<EditArtifactLike>
): FileChangeInfo[] {
  const byPath = new Map<
    string,
    FileChangeInfo & { lastSequenceIndex: number }
  >();

  for (const artifact of artifacts) {
    const normalizedPath = normalizeDiffFilePath(artifact.filePath);
    if (!normalizedPath) continue;

    const existing = byPath.get(normalizedPath);
    const status = artifact.editKind === "delete" ? "D" : "M";
    if (existing) {
      existing.additions += artifact.linesAdded;
      existing.deletions += artifact.linesRemoved;
      existing.lineCount = existing.additions + existing.deletions;
      if (artifact.sequenceIndex >= existing.lastSequenceIndex) {
        existing.status = status;
        existing.lastSequenceIndex = artifact.sequenceIndex;
      }
    } else {
      byPath.set(normalizedPath, {
        path: normalizedPath,
        fileName: getFileName(normalizedPath),
        status,
        additions: artifact.linesAdded,
        deletions: artifact.linesRemoved,
        lineCount: artifact.linesAdded + artifact.linesRemoved,
        lastSequenceIndex: artifact.sequenceIndex,
      });
    }
  }

  return Array.from(byPath.values()).map(
    ({ lastSequenceIndex: _lastSequenceIndex, ...file }) => file
  );
}

/** Minimal chat-event shape needed to count round boundaries. */
export interface ChatRoundEvent {
  source?: string | null;
  displayText?: string | null;
}

/**
 * Count chat "rounds" by user-message boundaries — matching `useChatGroups`,
 * which opens a new group at each `source === "user"` event with display text.
 * User messages do not appear mid-stream, so this stays stable during a
 * streaming turn and only grows when a new round begins.
 */
export function countChatRounds(events: ReadonlyArray<ChatRoundEvent>): number {
  let count = 0;
  for (const event of events) {
    if (event.source === "user" && Boolean(event.displayText)) {
      count += 1;
    }
  }
  return count;
}

/**
 * Build the composer files pill's reload signal. Shaped like the per-round
 * footer's `turnFilesReloadKey` (`${sessionId}:${roundCount}:${working|idle}`)
 * so the orgtrack snapshot is refetched when the session changes, a new round
 * appears, or the agent transitions to idle — never on every streamed tick.
 */
export function buildCompactFilesReloadKey(
  sessionId: string | null,
  roundCount: number,
  isAgentWorking: boolean
): string {
  return `${sessionId ?? ""}:${roundCount}:${isAgentWorking ? "working" : "idle"}`;
}
