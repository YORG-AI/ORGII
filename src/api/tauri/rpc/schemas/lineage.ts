/**
 * Lineage RPC Schemas
 *
 * Zod schemas for get_session_impact / get_provenance_session_ids commands.
 * Rust source: src-tauri/src/project_management/lineage/
 *
 * Note: get_session_impact returns serde_json::Value in Rust, but we
 * describe the known SessionImpact shape from analytics.rs.
 */
import { z } from "zod/v4";

// ── Input schemas ──

export const GetSessionImpactInput = z.object({
  sessionId: z.string(),
});

// ── Output schemas ──

export const FunctionEntrySchema = z.object({
  file: z.string(),
  name: z.string(),
  nodeType: z.string(),
  lines: z.tuple([z.number().int(), z.number().int()]),
});

export const SessionImpactSchema = z.object({
  sessionId: z.string(),
  filesTouched: z.array(z.string()),
  functionsCreated: z.array(FunctionEntrySchema),
  commitsInfluenced: z.array(z.string()),
  totalLinesAttributed: z.number().int(),
  firstEditAt: z.number().int().nullable().optional(),
  lastCommitAt: z.number().int().nullable().optional(),
});

export const OrgtrackTierSchema = z.enum(["meta", "details", "trajectory"]);
export const OrgtrackTimelineEntryTypeSchema = z.enum([
  "session_edit",
  "commit_link",
]);

export const OrgtrackExportInput = z.object({
  repoPath: z.string(),
  tier: OrgtrackTierSchema.optional(),
  allowRawTrajectory: z.boolean().optional(),
});

export const OrgtrackScanStartInput = z.object({
  repoPath: z.string(),
  tier: OrgtrackTierSchema.optional(),
  allowRawTrajectory: z.boolean().optional(),
  resume: z.boolean().optional(),
  rebuild: z.boolean().optional(),
});

export const OrgtrackScanStatusInput = z.object({
  repoPath: z.string(),
});

export const OrgtrackScanCancelInput = z.object({
  repoPath: z.string(),
});

export const OrgtrackScanStatusSchema = z.enum([
  "idle",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const OrgtrackScanPhaseSchema = z.enum([
  "discover",
  "provenance",
  "local_edits",
  "sessions",
  "commits",
  "index",
  "done",
]);

export const OrgtrackScanCountsSchema = z.object({
  sessions: z.number().int(),
  files: z.number().int(),
  commits: z.number().int(),
  entries: z.number().int(),
  records: z.number().int(),
});

export const OrgtrackScanProgressSchema = z.object({
  schemaVersion: z.number().int(),
  repoPath: z.string(),
  tier: OrgtrackTierSchema,
  status: OrgtrackScanStatusSchema,
  phase: OrgtrackScanPhaseSchema,
  processed: z.number().int(),
  total: z.number().int(),
  counts: OrgtrackScanCountsSchema,
  lastError: z.string().nullable().optional(),
  resumable: z.boolean(),
  cancelRequested: z.boolean(),
  startedAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().nullable().optional(),
});

export const OrgtrackIndexInput = z.object({
  repoPath: z.string(),
});

export const OrgtrackFileTimelineInput = z.object({
  repoPath: z.string(),
  filePath: z.string(),
});

export const OrgtrackFileSessionLookupInput = z.object({
  repoPath: z.string(),
  filePath: z.string(),
});

export const OrgtrackSessionSummariesInput = z.object({
  workspacePath: z.string().optional(),
});

export const OrgtrackSessionSummaryInput = z.object({
  sessionId: z.string(),
});

export const OrgtrackAnalyzeSessionsInput = z.object({
  workspacePath: z.string().optional(),
  sessionId: z.string().optional(),
  rebuild: z.boolean().optional(),
});

export const OrgtrackAnalysisBackfillStatsSchema = z.object({
  scannedSessions: z.number().int(),
  analyzedSessions: z.number().int(),
  skippedSessions: z.number().int(),
  failedSessions: z.number().int(),
});

export const OrgtrackReachabilityStateSchema = z.enum([
  "uncommitted",
  "linked_unreachable",
  "reachable_exact",
  "landed_equivalent",
  "reverted_or_absent",
  "unknown",
]);

export const OrgtrackTierSupportSchema = z.enum([
  "default",
  "opt_in",
  "unsupported",
]);

export const OrgtrackSourceTierPolicySchema = z.object({
  tier1: OrgtrackTierSupportSchema,
  tier2: OrgtrackTierSupportSchema,
  tier3: OrgtrackTierSupportSchema,
});

export const OrgtrackSourceTierPolicyInput = z.object({
  source: z.string(),
});

export const OrgtrackExtractionMemoryDecisionSchema = z.enum([
  "run",
  "pause_soft",
  "pause_hard",
  "pause_system_memory",
]);

export const OrgtrackExtractionMemoryGateSchema = z.object({
  decision: OrgtrackExtractionMemoryDecisionSchema,
  rustRssMb: z.number(),
  systemAvailableMb: z.number(),
  shouldResume: z.boolean(),
});

export const OrgtrackSessionArtifactQueryInput = z.object({
  source: z.string().optional(),
  sessionId: z.string().optional(),
});

export const OrgtrackCheckpointFileStateInput = z.object({
  checkpointId: z.string(),
});

export const OrgtrackEditKindSchema = z.enum([
  "read",
  "write",
  "delete",
  "patch",
  "commit_boundary",
  "unknown",
]);

export const OrgtrackArtifactQualitySchema = z.enum([
  "exact",
  "patch_reversible",
  "inferred",
  "stats_only",
]);

export const OrgtrackCheckpointKindSchema = z.enum([
  "pre_message_snapshot",
  "post_tool_call",
  "post_turn",
  "explicit_user_checkpoint",
  "commit_boundary",
  "inferred",
]);

export const OrgtrackParsedCategorySchema = z.object({
  key: z.string(),
  value: z.string(),
  source: z.string(),
});

export const OrgtrackAgentIdentitySchema = z.object({
  dispatchCategory: z.string().nullable().optional(),
  rustAgentType: z.string().nullable().optional(),
  cliAgentType: z.string().nullable().optional(),
  agentExecMode: z.string().nullable().optional(),
  sessionId: z.string(),
  displayName: z.string().nullable().optional(),
  providerModelType: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  keySource: z.string().nullable().optional(),
  origin: z.string().nullable().optional(),
  parsedCategories: z.array(OrgtrackParsedCategorySchema),
});

export const OrgtrackAgentMetadataSchema = z.object({
  dispatchCategory: z.string().nullable().optional(),
  rustAgentType: z.string().nullable().optional(),
  cliAgentType: z.string().nullable().optional(),
  agentExecMode: z.string().nullable().optional(),
  displayName: z.string().nullable().optional(),
  providerModelType: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  keySource: z.string().nullable().optional(),
  origin: z.string().nullable().optional(),
  parsedCategories: z.record(z.string(), z.string()),
});

export const OrgtrackSessionEditArtifactSchema = z.object({
  schemaVersion: z.number().int(),
  recordId: z.string(),
  source: z.string(),
  sourceSessionId: z.string().nullable().optional(),
  sessionId: z.string(),
  sourceEventId: z.string().nullable().optional(),
  turnId: z.string().nullable().optional(),
  sequenceIndex: z.number().int(),
  timestamp: z.string().nullable().optional(),
  workspacePath: z.string().nullable().optional(),
  filePath: z.string(),
  pathHash: z.string(),
  editKind: OrgtrackEditKindSchema,
  oldStartLine: z.number().int().nullable().optional(),
  newStartLine: z.number().int().nullable().optional(),
  startLine: z.number().int().nullable().optional(),
  endLine: z.number().int().nullable().optional(),
  linesAdded: z.number().int(),
  linesRemoved: z.number().int(),
  quality: OrgtrackArtifactQualitySchema,
  metadata: OrgtrackAgentMetadataSchema,
});

export const OrgtrackSessionDiffChunkSchema = z.object({
  schemaVersion: z.number().int(),
  recordId: z.string(),
  editRecordId: z.string(),
  source: z.string(),
  sessionId: z.string(),
  sourceEventId: z.string().nullable().optional(),
  sequenceIndex: z.number().int(),
  chunkIndex: z.number().int(),
  filePath: z.string(),
  oldStartLine: z.number().int().nullable().optional(),
  newStartLine: z.number().int().nullable().optional(),
  oldContent: z.string().nullable().optional(),
  newContent: z.string().nullable().optional(),
  diff: z.string().nullable().optional(),
  linesAdded: z.number().int(),
  linesRemoved: z.number().int(),
  isDeleted: z.boolean(),
  quality: OrgtrackArtifactQualitySchema,
});

export const OrgtrackSessionFinalDiffSchema = z.object({
  schemaVersion: z.number().int(),
  recordId: z.string(),
  source: z.string(),
  sessionId: z.string(),
  filePath: z.string(),
  baselineEventId: z.string().nullable().optional(),
  finalEventId: z.string().nullable().optional(),
  oldContent: z.string().nullable().optional(),
  newContent: z.string().nullable().optional(),
  diff: z.string().nullable().optional(),
  linesAdded: z.number().int(),
  linesRemoved: z.number().int(),
  isDeleted: z.boolean().optional(),
  quality: OrgtrackArtifactQualitySchema,
  differsFromSummedChunks: z.boolean(),
  computedAt: z.string(),
});

export const OrgtrackCommitLinkSchema = z.object({
  schemaVersion: z.number().int(),
  recordId: z.string(),
  commitSha: z.string(),
  filePaths: z.array(z.string()),
  sessionIds: z.array(z.string()),
  reachabilityState: z.string(),
  linkedAt: z.string(),
});

export const OrgtrackSubmissionCommitPersonSchema = z.object({
  name: z.string(),
  email: z.string(),
  date: z.string(),
});

export const OrgtrackSubmissionCommitSchema = z.object({
  sha: z.string(),
  short_sha: z.string(),
  summary: z.string(),
  author: OrgtrackSubmissionCommitPersonSchema.nullable().optional(),
  repoId: z.string().optional(),
  repoPath: z.string().optional(),
  origin: z.enum(["created", "mentioned"]),
});

export const OrgtrackDiffReplayPreviewInput =
  OrgtrackSessionArtifactQueryInput.extend({
    repoId: z.string().optional(),
    repoPath: z.string().optional(),
  });

export const OrgtrackDiffReplayPreviewSchema = z.object({
  finalDiffs: z.array(OrgtrackSessionFinalDiffSchema),
  submissionCommits: z.array(OrgtrackSubmissionCommitSchema),
});

export const OrgtrackSessionCheckpointSchema = z.object({
  schemaVersion: z.number().int(),
  checkpointId: z.string(),
  source: z.string(),
  sourceSessionId: z.string().nullable().optional(),
  sessionId: z.string(),
  sequenceIndex: z.number().int(),
  sourceEventId: z.string().nullable().optional(),
  turnId: z.string().nullable().optional(),
  checkpointKind: OrgtrackCheckpointKindSchema,
  timestamp: z.string().nullable().optional(),
  affectedFilePaths: z.array(z.string()),
  editRecordIds: z.array(z.string()),
  quality: OrgtrackArtifactQualitySchema,
  undoSupported: z.boolean(),
  metadataJson: z.string().nullable().optional(),
});

export const OrgtrackCheckpointFileStateSchema = z.object({
  schemaVersion: z.number().int(),
  recordId: z.string(),
  checkpointId: z.string(),
  sessionId: z.string(),
  filePath: z.string(),
  content: z.string().nullable().optional(),
  reversePatch: z.string().nullable().optional(),
  diff: z.string().nullable().optional(),
  contentHash: z.string().nullable().optional(),
  quality: OrgtrackArtifactQualitySchema,
});

export const OrgtrackBranchContextSchema = z.object({
  authoringBranch: z.string().nullable().optional(),
  authoringHeadSha: z.string().nullable().optional(),
  authoringBaseBranch: z.string().nullable().optional(),
  authoringBaseSha: z.string().nullable().optional(),
  defaultBranch: z.string().nullable().optional(),
  worktreePathHash: z.string().nullable().optional(),
});

export const OrgtrackReachabilitySchema = z.object({
  state: OrgtrackReachabilityStateSchema,
  checkedAtHead: z.string().nullable().optional(),
  isReachableFromCurrentHead: z.boolean().nullable().optional(),
  isReachableFromDefaultBranch: z.boolean().nullable().optional(),
  firstReachableCommitSha: z.string().nullable().optional(),
  currentFileContainsAttributedRange: z.string().nullable().optional(),
});

export const OrgtrackExportResultSchema = z.object({
  repoPath: z.string(),
  orgtrackPath: z.string(),
  exportedTier: OrgtrackTierSchema,
  sessionsWritten: z.number().int(),
  filesWritten: z.number().int(),
  commitsWritten: z.number().int(),
  entriesWritten: z.number().int(),
  recordsWritten: z.number().int(),
  manifestVersion: z.number().int(),
});

export const OrgtrackIndexSessionSchema = z.object({
  sessionId: z.string(),
  label: z.string(),
  filesCount: z.number().int(),
  commitsCount: z.number().int(),
  committedFilesCount: z.number().int().optional(),
  committedRatePercent: z.number().int().optional(),
  firstEditAt: z.number().int().nullable().optional(),
  lastEditAt: z.number().int().nullable().optional(),
  agentIdentity: OrgtrackAgentIdentitySchema,
});

export const OrgtrackIndexFileSchema = z.object({
  path: z.string(),
  pathHash: z.string(),
  sessionsCount: z.number().int(),
  commitsCount: z.number().int(),
  entriesCount: z.number().int(),
});

export const OrgtrackIndexCommitSchema = z.object({
  commitSha: z.string(),
  filesCount: z.number().int(),
  sessionsCount: z.number().int(),
  reachabilityState: OrgtrackReachabilityStateSchema,
});

export const OrgtrackSummaryBucketSchema = z.object({
  key: z.string(),
  label: z.string(),
  count: z.number().int(),
});

export const OrgtrackIndexSummarySchema = z.object({
  sessionsByAppType: z.array(OrgtrackSummaryBucketSchema),
  modelsUsed: z.array(OrgtrackSummaryBucketSchema),
  totalSessions: z.number().int(),
  totalFiles: z.number().int(),
  totalCommits: z.number().int(),
  totalEntries: z.number().int(),
});

export const OrgtrackIndexSchema = z.object({
  schemaVersion: z.number().int(),
  generatedAt: z.string(),
  exportedTier: OrgtrackTierSchema,
  derivedVersion: z.number().int(),
  summary: OrgtrackIndexSummarySchema,
  sessions: z.array(OrgtrackIndexSessionSchema),
  files: z.array(OrgtrackIndexFileSchema),
  commits: z.array(OrgtrackIndexCommitSchema),
});

export const OrgtrackFileTimelineEntrySchema = z.object({
  entryType: OrgtrackTimelineEntryTypeSchema,
  id: z.string(),
  filePath: z.string(),
  sessionId: z.string().nullable().optional(),
  sessionLabel: z.string().nullable().optional(),
  agentIdentity: OrgtrackAgentIdentitySchema.nullable().optional(),
  branchContext: OrgtrackBranchContextSchema,
  commitSha: z.string().nullable().optional(),
  reachability: OrgtrackReachabilitySchema,
  timestamp: z.number().int(),
  summary: z.string().nullable().optional(),
  functionName: z.string().nullable().optional(),
  nodeType: z.string().nullable().optional(),
  startLine: z.number().int().nullable().optional(),
  endLine: z.number().int().nullable().optional(),
  tier: OrgtrackTierSchema,
});

export const OrgtrackFileTimelineSchema = z.object({
  schemaVersion: z.number().int(),
  filePath: z.string(),
  pathHash: z.string(),
  entries: z.array(OrgtrackFileTimelineEntrySchema),
});

export const OrgtrackFileSessionSummarySchema = z.object({
  sessionId: z.string(),
  sessionLabel: z.string().nullable().optional(),
  agentIdentity: OrgtrackAgentIdentitySchema.nullable().optional(),
  firstEditAt: z.number().int(),
  lastEditAt: z.number().int(),
  editCount: z.number().int(),
  commitShas: z.array(z.string()),
  reachabilityStates: z.array(OrgtrackReachabilityStateSchema),
});

export const OrgtrackFileSessionLookupSchema = z.object({
  schemaVersion: z.number().int(),
  filePath: z.string(),
  pathHash: z.string(),
  sessions: z.array(OrgtrackFileSessionSummarySchema),
});

export type FunctionEntry = z.output<typeof FunctionEntrySchema>;
export type SessionImpact = z.output<typeof SessionImpactSchema>;
export type OrgtrackTier = z.output<typeof OrgtrackTierSchema>;
export type OrgtrackTierSupport = z.output<typeof OrgtrackTierSupportSchema>;
export type OrgtrackSourceTierPolicy = z.output<
  typeof OrgtrackSourceTierPolicySchema
>;
export type OrgtrackExtractionMemoryGate = z.output<
  typeof OrgtrackExtractionMemoryGateSchema
>;
export type OrgtrackAnalysisBackfillStats = z.output<
  typeof OrgtrackAnalysisBackfillStatsSchema
>;
export type OrgtrackSessionEditArtifact = z.output<
  typeof OrgtrackSessionEditArtifactSchema
>;
export type OrgtrackSessionDiffChunk = z.output<
  typeof OrgtrackSessionDiffChunkSchema
>;
export type OrgtrackSessionFinalDiff = z.output<
  typeof OrgtrackSessionFinalDiffSchema
>;
export type OrgtrackCommitLink = z.output<typeof OrgtrackCommitLinkSchema>;
export type OrgtrackDiffReplayPreview = z.output<
  typeof OrgtrackDiffReplayPreviewSchema
>;
export type OrgtrackSessionCheckpoint = z.output<
  typeof OrgtrackSessionCheckpointSchema
>;
export type OrgtrackCheckpointFileState = z.output<
  typeof OrgtrackCheckpointFileStateSchema
>;
export type OrgtrackExportResult = z.output<typeof OrgtrackExportResultSchema>;
export type OrgtrackScanStatus = z.output<typeof OrgtrackScanStatusSchema>;
export type OrgtrackScanPhase = z.output<typeof OrgtrackScanPhaseSchema>;
export type OrgtrackScanCounts = z.output<typeof OrgtrackScanCountsSchema>;
export type OrgtrackScanProgress = z.output<typeof OrgtrackScanProgressSchema>;
export type OrgtrackIndex = z.output<typeof OrgtrackIndexSchema>;
export type OrgtrackFileTimeline = z.output<typeof OrgtrackFileTimelineSchema>;
export const CoreSessionSummarySchema = z.object({
  sessionId: z.string(),
  title: z.string(),
  source: z.string(),
  workspacePath: z.string().nullable().optional(),
  filesChanged: z.number().int(),
  linesAdded: z.number().int(),
  linesRemoved: z.number().int(),
  relatedCommits: z.number().int(),
  committedRatePercent: z.number().int(),
  model: z.string().nullable().optional(),
  keySource: z.string().nullable().optional(),
});

export type OrgtrackFileSessionLookup = z.output<
  typeof OrgtrackFileSessionLookupSchema
>;
export type CoreSessionSummary = z.output<typeof CoreSessionSummarySchema>;
export type OrgtrackFileTimelineEntry = z.output<
  typeof OrgtrackFileTimelineEntrySchema
>;
