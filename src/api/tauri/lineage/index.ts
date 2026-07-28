/**
 * Lineage API
 *
 * Chat Session Impact Graph — queries AI session provenance and commit lineage
 * from the Rust backend.
 * Delegates to tauri/rpc for type-safe Zod-validated IPC.
 */
import { rpc } from "@src/api/tauri/rpc";
import type {
  CoreSessionSummary,
  FunctionEntry,
  OrgtrackCheckpointFileState,
  OrgtrackCommitLink,
  OrgtrackDiffReplayPreview,
  OrgtrackExportResult,
  OrgtrackExtractionMemoryGate,
  OrgtrackFileSessionHistory,
  OrgtrackFileTimeline,
  OrgtrackIndex,
  OrgtrackSessionCheckpoint,
  OrgtrackSessionDiffChunk,
  OrgtrackSessionEditArtifact,
  OrgtrackSessionFinalDiff,
  OrgtrackSourceTierPolicy,
  OrgtrackTier,
  SessionImpact,
} from "@src/api/tauri/rpc/schemas/lineage";

// Re-export types for backward compat
export type {
  CoreSessionSummary,
  FunctionEntry,
  OrgtrackCheckpointFileState,
  OrgtrackDiffReplayPreview,
  OrgtrackExportResult,
  OrgtrackExtractionMemoryGate,
  OrgtrackCommitLink,
  OrgtrackFileSessionHistory,
  OrgtrackFileTimeline,
  OrgtrackIndex,
  OrgtrackSessionCheckpoint,
  OrgtrackSessionDiffChunk,
  OrgtrackSessionEditArtifact,
  OrgtrackSessionFinalDiff,
  OrgtrackSourceTierPolicy,
  OrgtrackTier,
  SessionImpact,
};

export async function getProvenanceSessionIds(): Promise<string[]> {
  return rpc.lineage.getProvenanceSessionIds();
}

export async function getSessionImpact(
  sessionId: string
): Promise<SessionImpact> {
  return rpc.lineage.getSessionImpact({ sessionId });
}

export async function initializeOrgtrack(input: {
  repoPath: string;
  tier?: OrgtrackTier;
  allowRawTrajectory?: boolean;
}): Promise<OrgtrackExportResult> {
  return rpc.lineage.orgtrackInitialize(input);
}

export async function syncOrgtrackCoreRepo(
  repoPath: string
): Promise<OrgtrackIndex> {
  return rpc.lineage.orgtrackSyncCoreRepo({ repoPath });
}

export async function exportOrgtrack(input: {
  repoPath: string;
  tier?: OrgtrackTier;
  allowRawTrajectory?: boolean;
}): Promise<OrgtrackExportResult> {
  return rpc.lineage.orgtrackExport(input);
}

export async function getOrgtrackFileTimeline(input: {
  repoPath: string;
  filePath: string;
}): Promise<OrgtrackFileTimeline | null> {
  return rpc.lineage.orgtrackGetFileTimeline(input);
}

export async function getOrgtrackFileSessionHistory(input: {
  repoPath: string;
  filePath: string;
  limit?: number;
  offset?: number;
}): Promise<OrgtrackFileSessionHistory> {
  return rpc.lineage.orgtrackGetFileSessionHistory(input);
}

export interface IndexOrgtrackCollaborationSessionInput {
  localSessionId: string;
  sourceSessionId: string;
  title: string;
  workspacePath: string;
  sourceWorkspacePath?: string;
  orgId: string;
  sessionRowId: string;
  ownerMemberId: string;
  ownerDisplayName: string;
}

export async function indexOrgtrackCollaborationSession(
  input: IndexOrgtrackCollaborationSessionInput
): Promise<number> {
  return rpc.lineage.orgtrackIndexCollaborationSession(input);
}

export async function deleteOrgtrackCollaborationSession(
  localSessionId: string
): Promise<void> {
  await rpc.lineage.orgtrackDeleteCollaborationSession({ localSessionId });
}

export async function getOrgtrackSessionSummaries(
  input: {
    workspacePath?: string;
  } = {}
): Promise<CoreSessionSummary[]> {
  return rpc.lineage.orgtrackGetSessionSummaries(input);
}

export async function getOrgtrackSessionSummary(
  sessionId: string
): Promise<CoreSessionSummary | null> {
  return rpc.lineage.orgtrackGetSessionSummary({ sessionId });
}

/**
 * Delete a session's derived orgtrack artifacts without recomputing them.
 * Checkpoint-restore uses this to drop diff rows that no longer match the
 * rewound event stream — a pure invalidation, never an analysis pass.
 */
export async function deleteOrgtrackSessionArtifacts(
  sessionId: string
): Promise<void> {
  await rpc.lineage.orgtrackDeleteSessionArtifacts({ sessionId });
}

export async function getOrgtrackSourceTierPolicy(
  source: string
): Promise<OrgtrackSourceTierPolicy> {
  return rpc.lineage.orgtrackGetSourceTierPolicy({ source });
}

export async function getOrgtrackExtractionMemoryGate(): Promise<OrgtrackExtractionMemoryGate> {
  return rpc.lineage.orgtrackGetExtractionMemoryGate();
}

export async function getOrgtrackSessionEditArtifacts(input: {
  source?: string;
  sessionId?: string;
}): Promise<OrgtrackSessionEditArtifact[]> {
  return rpc.lineage.orgtrackGetSessionEditArtifacts(input);
}

export async function getOrgtrackSessionDiffChunks(input: {
  source?: string;
  sessionId?: string;
}): Promise<OrgtrackSessionDiffChunk[]> {
  return rpc.lineage.orgtrackGetSessionDiffChunks(input);
}

export async function getOrgtrackSessionFinalDiffs(input: {
  source?: string;
  sessionId?: string;
}): Promise<OrgtrackSessionFinalDiff[]> {
  return rpc.lineage.orgtrackGetSessionFinalDiffs(input);
}

export async function getOrgtrackDiffReplayPreview(input: {
  source?: string;
  sessionId?: string;
  repoId?: string;
  repoPath?: string;
}): Promise<OrgtrackDiffReplayPreview> {
  return rpc.lineage.orgtrackGetDiffReplayPreview(input);
}

export async function getOrgtrackSessionCommitLinks(
  input: { sessionId?: string } = {}
): Promise<OrgtrackCommitLink[]> {
  return rpc.lineage.orgtrackGetSessionCommitLinks(input);
}

export async function getOrgtrackSessionCheckpoints(input: {
  source?: string;
  sessionId?: string;
}): Promise<OrgtrackSessionCheckpoint[]> {
  return rpc.lineage.orgtrackGetSessionCheckpoints(input);
}

export async function getOrgtrackCheckpointFileStates(
  checkpointId: string
): Promise<OrgtrackCheckpointFileState[]> {
  return rpc.lineage.orgtrackGetCheckpointFileStates({ checkpointId });
}
