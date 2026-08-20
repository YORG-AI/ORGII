import { z } from "zod/v4";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

const UnknownRecordSchema = z.record(z.string(), z.unknown());
const SafeU64NumberSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

function normalizeEventRecordValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    return { content: value, observation: value };
  }
  if (value == null) {
    return {};
  }
  return { value };
}

const EventRecordSchema = z.preprocess(
  normalizeEventRecordValue,
  UnknownRecordSchema
);

export const EventDisplayStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "pending",
  "awaiting_user",
]);

export const EventDisplayVariantSchema = z.enum([
  "tool_call",
  "message",
  "thinking",
  "plan",
  "approval",
  "session",
  "summary",
  "error",
]);

export const ActivityStatusSchema = z.enum(["agent", "pending", "processed"]);

const ExtractedDataSchema = z.unknown();

export const PayloadRefSchema = z.object({
  eventId: z.string(),
  fieldPath: z.string(),
  preview: z.string(),
  fullSizeBytes: z.number(),
  truncated: z.boolean(),
});

export const EventPayloadBodySchema = z.object({
  eventId: z.string(),
  fieldPath: z.string(),
  body: z.string(),
  fullSizeBytes: z.number(),
});

export const ShellReplayStatusSchema = z.enum([
  "running",
  "complete",
  "incomplete",
]);

export const ShellReplayRefSchema = z.object({
  sessionId: z.string(),
  callId: z.string(),
  formatVersion: z.number().int().positive(),
});

export const ShellReplayBookmarkSchema = z.object({
  visibleThroughSequence: SafeU64NumberSchema,
  visibleBytes: SafeU64NumberSchema,
});

export const ShellReplayStateSchema = z.object({
  ref: ShellReplayRefSchema,
  bookmark: ShellReplayBookmarkSchema,
  terminalPreview: z.string(),
  status: ShellReplayStatusSchema,
  completedAt: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

export const ShellReplayRangeInput = z.object({
  sessionId: z.string().min(1),
  callId: z.string().min(1),
  visibleThroughSequence: SafeU64NumberSchema,
  visibleBytes: SafeU64NumberSchema,
  offsetBytes: SafeU64NumberSchema,
  limitBytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1024),
});

export const ShellReplayFrameSchema = z.object({
  sequence: SafeU64NumberSchema,
  stream: z.enum(["stdout", "stderr"]),
  byteStart: SafeU64NumberSchema,
  byteEnd: SafeU64NumberSchema,
  text: z.string(),
});

export const ShellReplayRangeSchema = z.object({
  frames: z.array(ShellReplayFrameSchema),
  nextOffsetBytes: SafeU64NumberSchema,
  eof: z.boolean(),
});

const SessionEventRuntimeSchema = z
  .object({
    chunk_id: z.string().nullable(),
    id: z.string(),
    sessionId: z.string(),
    createdAt: z.string(),
    functionName: z.string(),
    uiCanonical: z.string(),
    actionType: z.string(),
    args: EventRecordSchema,
    result: EventRecordSchema,
    source: z.enum(["assistant", "user", "system"]),
    displayText: z.string(),
    displayStatus: EventDisplayStatusSchema,
    displayVariant: EventDisplayVariantSchema,
    activityStatus: ActivityStatusSchema,
    threadId: z.string().optional(),
    processId: z.string().optional(),
    callId: z.string().optional(),
    filePath: z.string().optional(),
    command: z.string().optional(),
    isDelta: z.boolean().optional(),
    repoId: z.string().optional(),
    repoPath: z.string().optional(),
    shellPid: z.number().optional(),
    shellProcessStatus: z
      .enum(["running", "background", "exited", "killed"])
      .optional(),
    shellExitCode: z.number().optional(),
    shellLogPath: z.string().optional(),
    shellReplay: ShellReplayStateSchema.optional(),
    shellReplayBookmarks: z
      .record(z.string(), ShellReplayStateSchema)
      .optional(),
    extracted: ExtractedDataSchema.optional(),
    payloadRefs: z.array(PayloadRefSchema).optional(),
  })
  .catchall(z.unknown());

export const SessionEventSchema = SessionEventRuntimeSchema as z.ZodType<
  SessionEvent,
  SessionEvent
>;

export const SessionEventArraySchema = z.array(SessionEventSchema);

export const ExtractedEventDataWindowInput = z.object({
  sessionId: z.string().optional(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});

export const ExtractedEventDataPairSchema = z.tuple([
  z.string(),
  ExtractedDataSchema,
]);

export const ExtractedEventDataPairsSchema = z.array(
  ExtractedEventDataPairSchema
);

const SessionEventPartialRuntimeSchema =
  SessionEventRuntimeSchema.partial().catchall(z.unknown());

export const SessionEventPartialSchema =
  SessionEventPartialRuntimeSchema as z.ZodType<
    Partial<SessionEvent>,
    Partial<SessionEvent>
  >;

export const ReplayTimeRangeSchema = z.object({
  start: z.string(),
  end: z.string(),
});

export const SessionSpecSchema = z.object({
  specId: z.string(),
  sessionId: z.string(),
  spec: z.string(),
  content: z.string().optional(),
  createdTime: z.string(),
  status: z.string().optional(),
  stepId: z.string().nullable().optional(),
});

export const SessionMetadataSchema = z.object({
  sessionId: z.string(),
  eventCount: z.number(),
  cachedAt: z.number(),
  contentRevision: z.number(),
  timeRangeStart: z.string().optional(),
  timeRangeEnd: z.string().optional(),
});

export const TurnMetadataIndexInput = z.object({
  sessionId: z.string(),
  turnIds: z.array(z.string()).max(500).optional(),
});

export const SearchResultSchema = z.object({
  event: SessionEventSchema,
  rank: z.number(),
  snippet: z.string(),
});

export const CacheStatsSchema = z.object({
  totalSessions: z.number(),
  totalEvents: z.number(),
  dbSizeBytes: z.number(),
});

export const TruncateResultSchema = z.object({
  deletedCount: z.number(),
  deletedIds: z.array(z.string()),
  deletedSequences: z.array(z.number()),
});

export const FullSessionPayloadSchema = z.object({
  sessionId: z.string(),
  events: SessionEventArraySchema,
  specsJson: z.string().optional(),
  timeRangeStart: z.string().optional(),
  timeRangeEnd: z.string().optional(),
});

export const DerivedSnapshotSchema = z.object({
  version: z.number(),
  eventCount: z.number(),
  events: SessionEventArraySchema,
  chatEvents: SessionEventArraySchema,
  messagesEvents: SessionEventArraySchema,
  sortedSimulatorEvents: SessionEventArraySchema,
  lastEvent: SessionEventSchema.nullable(),
  eventIndex: z.record(z.string(), z.number()),
  chatEventCount: z.number(),
  hasRunningEvent: z.boolean(),
});

export const NullableSessionIdInput = z.object({
  sessionId: z.string().nullable(),
});

export const RemoveSyntheticUserInputsInput = z.object({
  sessionId: z.string().nullable(),
  matchingContents: z.array(z.string()).optional(),
  olderThan: z.string().optional(),
});

export const SessionIdInput = z.object({
  sessionId: z.string(),
});

export const EventsInput = z.object({
  events: SessionEventArraySchema,
  sessionId: z.string().nullable(),
});

export const EventInput = z.object({
  event: SessionEventSchema,
  sessionId: z.string().nullable(),
});

export const UpdateByIdInput = z.object({
  id: z.string(),
  patch: SessionEventPartialSchema,
  sessionId: z.string().nullable(),
});

export const StreamingInput = z.object({
  streaming: z.boolean(),
  sessionId: z.string().nullable(),
});

export const TruncateBeforeIdInput = z.object({
  eventId: z.string(),
  sessionId: z.string().nullable(),
});

export const PatchByIdsInput = z.object({
  ids: z.array(z.string()),
  patch: SessionEventPartialSchema,
  sessionId: z.string().nullable(),
});

export const RemoveByIdPrefixInput = z.object({
  prefix: z.string(),
  sessionId: z.string().nullable(),
});

export const ReplaceAndRemoveInput = z.object({
  removeId: z.string().nullable(),
  newEvent: SessionEventSchema,
  sessionId: z.string().nullable(),
});

export const UpdateActiveTaskArgsInput = z.object({
  mergeArgs: UnknownRecordSchema,
  functionNames: z.array(z.string()).nullable(),
  sessionId: z.string().nullable(),
});

export const ActiveTaskInput = z.object({
  functionNames: z.array(z.string()).nullable(),
  sessionId: z.string().nullable(),
});

export const SaveEventsInput = z.object({
  sessionId: z.string(),
  events: SessionEventArraySchema,
});

export const CachedEventRowSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  eventType: z.string(),
  functionName: z.string().nullable(),
  threadId: z.string().nullable(),
  argsJson: z.string(),
  resultJson: z.string(),
  content: z.string(),
  createdAt: z.string(),
  metaJson: z.string().nullable(),
  historySequence: z.number().nullable(),
});

export const CachedEventRowsSchema = z.array(CachedEventRowSchema);

export const SaveCachedEventsInput = z.object({
  sessionId: z.string(),
  events: CachedEventRowsSchema,
});

export const SearchEventsInput = z.object({
  sessionId: z.string(),
  query: z.string(),
  limit: z.number(),
});

export const SearchAllSessionsInput = z.object({
  query: z.string(),
  limit: z.number().optional(),
});

export const CrossSessionSearchHitSchema = z.object({
  sessionId: z.string(),
  snippet: z.string(),
  timestamp: z.string().nullable(),
  rank: z.number(),
});

export type CrossSessionSearchHit = z.output<
  typeof CrossSessionSearchHitSchema
>;

export const TurnStatusSchema = z.enum([
  "pending",
  "working",
  "completed",
  "interrupted",
  "failed",
]);

export const TurnModifiedFileSchema = z.object({
  path: z.string(),
  fileName: z.string(),
  status: z.enum(["created", "modified", "deleted"]),
  additions: z.number(),
  deletions: z.number(),
});

export type TurnModifiedFile = z.output<typeof TurnModifiedFileSchema>;

export const TurnResourceInteractionSchema = z.object({
  path: z.string(),
  fileName: z.string(),
  action: z.enum(["read", "write", "create", "delete", "rename", "search"]),
  outcome: z.enum(["succeeded", "failed", "unknown"]),
  count: z.number().int().nonnegative(),
  firstOccurredAt: z.string(),
  lastOccurredAt: z.string(),
});

export type TurnResourceInteraction = z.output<
  typeof TurnResourceInteractionSchema
>;

export const TurnGitArtifactSchema = z.object({
  kind: z.enum(["commit", "pullRequest"]),
  url: z.string().optional(),
  repoFullName: z.string().optional(),
  sha: z.string().optional(),
  shortSha: z.string().optional(),
  subject: z.string().optional(),
  prNumber: z.number().int().optional(),
  prTitle: z.string().optional(),
  sourceBranch: z.string().optional(),
  targetBranch: z.string().optional(),
});

export type TurnGitArtifact = z.output<typeof TurnGitArtifactSchema>;

export const TurnSummarySchema = z.object({
  sessionId: z.string(),
  turnId: z.string(),
  startSequence: z.number(),
  endSequence: z.number().nullable(),
  nextTurnId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  userEventIds: z.array(z.string()),
  userPreview: z.string(),
  eventCount: z.number(),
  bodyEventCount: z.number(),
  status: TurnStatusSchema,
  interrupted: z.boolean(),
  // Per-round modified files, materialized by the Rust turn indexer.
  modifiedFiles: z.array(TurnModifiedFileSchema).default([]),
  // Privacy-safe Orgtrack path/action aggregates for this round.
  resourceInteractions: z.array(TurnResourceInteractionSchema).default([]),
  // Exact commits/PRs produced by successful git/gh commands in this round.
  gitArtifacts: z.array(TurnGitArtifactSchema).default([]),
});

export const TurnBodyWindowInput = z.object({
  sessionId: z.string(),
  turnId: z.string(),
});

export const TurnBodyWindowSchema = z.object({
  turnId: z.string(),
  events: SessionEventArraySchema,
});

export const InitialTurnWindowInput = z.object({
  sessionId: z.string(),
  recentTurnCount: z.number().optional(),
});

export const InitialTurnWindowSchema = z.object({
  turns: z.array(TurnSummarySchema),
  events: SessionEventArraySchema,
});

export const ClearOldSessionsInput = z.object({
  maxAgeHours: z.number(),
});

export const SaveFullSessionInput = z.object({
  payload: FullSessionPayloadSchema,
});

export const EventIdInput = z.object({
  sessionId: z.string(),
  eventId: z.string(),
});

export const EventPayloadInput = z.object({
  sessionId: z.string(),
  eventId: z.string(),
  fieldPath: z.string(),
});

export const UpdateCacheEventInput = z.object({
  sessionId: z.string(),
  event: SessionEventSchema,
});

export const BufferEventsInput = z.object({
  sessionId: z.string(),
  events: SessionEventArraySchema,
});

export const MergeToolResultsInput = z.object({
  events: SessionEventArraySchema,
});

export const ProcessChunksInput = z.object({
  sessionId: z.string(),
  chunks: z.array(z.unknown()),
});

export const ProcessChunksOutput = z.object({
  events: SessionEventArraySchema,
});

export const NormalizeChunkInput = z.object({
  sessionId: z.string(),
  chunk: z.unknown(),
});

export const SetRepoContextInput = z.object({
  repoId: z.string().nullable(),
  repoPath: z.string().nullable(),
});
