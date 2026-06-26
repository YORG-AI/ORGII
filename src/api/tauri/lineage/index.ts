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
  OrgtrackAnalysisBackfillStats,
  OrgtrackCheckpointFileState,
  OrgtrackCommitLink,
  OrgtrackDiffReplayPreview,
  OrgtrackExportResult,
  OrgtrackExtractionMemoryGate,
  OrgtrackFileSessionLookup,
  OrgtrackFileTimeline,
  OrgtrackIndex,
  OrgtrackScanProgress,
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
  OrgtrackAnalysisBackfillStats,
  OrgtrackCheckpointFileState,
  OrgtrackDiffReplayPreview,
  OrgtrackExportResult,
  OrgtrackExtractionMemoryGate,
  OrgtrackCommitLink,
  OrgtrackFileSessionLookup,
  OrgtrackFileTimeline,
  OrgtrackIndex,
  OrgtrackScanProgress,
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

export async function startOrgtrackScan(input: {
  repoPath: string;
  tier?: OrgtrackTier;
  allowRawTrajectory?: boolean;
  resume?: boolean;
  rebuild?: boolean;
}): Promise<OrgtrackScanProgress> {
  return rpc.lineage.orgtrackScanStart(input);
}

export async function getOrgtrackScanStatus(
  repoPath: string
): Promise<OrgtrackScanProgress | null> {
  return rpc.lineage.orgtrackScanStatus({ repoPath });
}

export async function cancelOrgtrackScan(
  repoPath: string
): Promise<OrgtrackScanProgress> {
  return rpc.lineage.orgtrackScanCancel({ repoPath });
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

export async function getOrgtrackIndex(
  repoPath: string
): Promise<OrgtrackIndex | null> {
  return rpc.lineage.orgtrackGetIndex({ repoPath });
}

export async function getOrgtrackFileTimeline(input: {
  repoPath: string;
  filePath: string;
}): Promise<OrgtrackFileTimeline | null> {
  return rpc.lineage.orgtrackGetFileTimeline(input);
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

export async function analyzeOrgtrackSessions(
  input: {
    workspacePath?: string;
    sessionId?: string;
    rebuild?: boolean;
  } = {}
): Promise<OrgtrackAnalysisBackfillStats> {
  return rpc.lineage.orgtrackAnalyzeSessions(input);
}

export async function lookupOrgtrackFileSessions(input: {
  repoPath: string;
  filePath: string;
}): Promise<OrgtrackFileSessionLookup | null> {
  return rpc.lineage.orgtrackLookupFileSessions(input);
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
