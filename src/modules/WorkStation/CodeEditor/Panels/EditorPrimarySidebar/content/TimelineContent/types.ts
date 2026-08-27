/**
 * TimelineContent Types
 */
import type {
  OrgtrackFileSessionHistory,
  OrgtrackFileTimeline,
} from "@src/api/tauri/lineage";

export type OrgtrackFileTimelineEntry = OrgtrackFileTimeline["entries"][number];
export type FileSessionHistorySession =
  OrgtrackFileSessionHistory["sessions"][number];
export type FileSessionHistoryParticipant =
  FileSessionHistorySession["participants"][number];
export type CollaborationSessionOrigin = NonNullable<
  FileSessionHistorySession["collaborationOrigin"]
>;

export interface TimelineCommitInfo {
  /** Commit SHA */
  sha: string;
  /** Short SHA */
  shortSha: string;
  /** Commit message */
  message: string;
  /** Author name */
  author: string;
  /** Commit timestamp (ISO string) */
  timestamp: string;
}

export interface TimelineContentProps {
  /** Which history stream this sidebar section displays */
  variant: "git" | "session";
  /** Repository ID for git operations */
  repoId: string;
  /** Currently selected file path */
  filePath: string | null;
  /** Repository file system path for repo-local `.orgtrack` data */
  repoPath?: string;
  /** Selected commit SHA (from active timeline diff tab) */
  selectedCommitSha?: string | null;
  /** Callback when a commit is clicked - opens diff view */
  onCommitClick?: (
    commitSha: string,
    filePath: string,
    commitInfo: TimelineCommitInfo
  ) => void;
  /** Loading state from parent (file loading) */
  loading?: boolean;
}

export interface TimelineEntry {
  /** Commit SHA */
  sha: string;
  /** Short SHA (7 chars) */
  shortSha: string;
  /** Commit message (first line) */
  message: string;
  /** Author name */
  author: string;
  /** Commit timestamp */
  timestamp: string;
  /** Entry type (git commit or local save) */
  type: "commit" | "local";
}
