import { z } from "zod/v4";

import { IMPORTED_HISTORY_SOURCE_IDS } from "@src/types/session/externalHistory";

import { SessionEventArraySchema } from "./sessionCore";

const SafeIntegerSchema = z
  .number()
  .int()
  .min(Number.MIN_SAFE_INTEGER)
  .max(Number.MAX_SAFE_INTEGER);
const SafeU64Schema = SafeIntegerSchema.nonnegative();

export const ExternalReplaySourceIdSchema = z.enum([
  ...IMPORTED_HISTORY_SOURCE_IDS,
  "managed_cli",
  // ORGII-owned, already-persisted collaboration snapshots. This is
  // deliberately not part of the 15-vendor ImportedHistorySourceId mirror:
  // its source of truth is our own sessions.db `events` table.
  "collaboration_snapshot",
]);

export const ExternalReplayLimitsSchema = z
  .object({
    maxTurns: z.number().int().positive().max(10).optional(),
    maxEvents: z.number().int().positive().max(200).optional(),
    maxIpcBytes: z
      .number()
      .int()
      .positive()
      .max(4 * 1024 * 1024)
      .optional(),
  })
  .optional();

export const ExternalReplayCursorSchema = z.object({
  sourceId: ExternalReplaySourceIdSchema,
  sessionId: z.string().min(1),
  generation: z.string(),
  revision: SafeU64Schema,
  // `-1` is reserved for a managed native CLI whose transcript binding is
  // not available yet. No source bytes have been consumed in that state.
  throughSequence: SafeIntegerSchema,
});

export const ExternalReplayTurnHeaderSchema = z.object({
  turnId: z.string(),
  turnIndex: SafeU64Schema,
  startSequence: SafeU64Schema,
  endSequence: SafeU64Schema.nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  eventCount: SafeU64Schema,
});

export const ExternalReplayStatsSchema = z.object({
  parsedBytes: SafeU64Schema,
  parsedRows: SafeU64Schema,
  normalizedEvents: SafeU64Schema,
  upsertedEvents: SafeU64Schema,
  removedEvents: SafeU64Schema,
  ipcBytes: SafeU64Schema,
  notReady: z.boolean(),
});

export const ExternalReplayWindowSchema = z.object({
  cursor: ExternalReplayCursorSchema,
  events: SessionEventArraySchema,
  windowStartSequence: SafeU64Schema.nullable(),
  turnHeaders: z.array(ExternalReplayTurnHeaderSchema),
  totalEventCount: SafeU64Schema,
  totalTurnCount: SafeU64Schema,
  hasOlder: z.boolean(),
  watcherAvailable: z.boolean(),
  stats: ExternalReplayStatsSchema,
});

export const ExternalReplayDeltaSchema = z.object({
  cursor: ExternalReplayCursorSchema,
  events: SessionEventArraySchema,
  removedEventIds: z.array(z.string()),
  resetRequired: z.boolean(),
  watcherAvailable: z.boolean(),
  stats: ExternalReplayStatsSchema,
});

const ExternalReplayTargetInput = z.object({
  sourceId: ExternalReplaySourceIdSchema,
  sessionId: z.string().min(1),
});

export const ExternalReplayOpenWindowInput = ExternalReplayTargetInput.extend({
  episodeId: SafeU64Schema,
  limits: ExternalReplayLimitsSchema,
});

export const ExternalReplayPollDeltaInput = ExternalReplayTargetInput.extend({
  episodeId: SafeU64Schema,
  cursor: ExternalReplayCursorSchema,
  limits: ExternalReplayLimitsSchema,
});

export const ExternalReplayReadWindowInput = ExternalReplayTargetInput.extend({
  episodeId: SafeU64Schema,
  beforeSequence: SafeU64Schema.optional(),
  turnId: z.string().min(1).optional(),
  turnIndex: SafeU64Schema.optional(),
  limits: ExternalReplayLimitsSchema,
}).refine(
  ({ beforeSequence, turnId, turnIndex }) =>
    [beforeSequence, turnId, turnIndex].filter((value) => value !== undefined)
      .length <= 1,
  { message: "Choose only one replay window locator" }
);

export const ExternalReplayQueryWindowInput = ExternalReplayTargetInput.extend({
  beforeSequence: SafeU64Schema.optional(),
  turnId: z.string().min(1).optional(),
  turnIndex: SafeU64Schema.optional(),
  limits: ExternalReplayLimitsSchema,
}).refine(
  ({ beforeSequence, turnId, turnIndex }) =>
    [beforeSequence, turnId, turnIndex].filter((value) => value !== undefined)
      .length <= 1,
  { message: "Choose only one replay window locator" }
);

export const ExternalReplayHandoffInput = ExternalReplayTargetInput.extend({
  sourceName: z.string().trim().min(1).max(200),
});

export const ExternalReplayHandoffSchema = z.object({
  items: z.array(z.string().max(1200)).max(80),
  generation: z.string(),
  scannedBytes: SafeU64Schema.max(4 * 1024 * 1024),
  scannedEvents: SafeU64Schema,
});

export const ExternalReplayReleaseInput = ExternalReplayTargetInput.extend({
  episodeId: SafeU64Schema,
});

export const ExternalReplayApplyQueryWindowInput =
  ExternalReplayTargetInput.extend({
    generation: z.string().min(1),
    revision: SafeU64Schema,
    replace: z.boolean(),
    events: SessionEventArraySchema.refine((events) => events.length <= 200, {
      message: "A bounded replay apply accepts at most 200 events",
    }),
  });

export const ExternalReplayReadPayloadRangeInput =
  ExternalReplayTargetInput.extend({
    generation: z.string(),
    eventId: z.string().min(1),
    fieldPath: z.string().min(1),
    offset: SafeU64Schema,
    maxBytes: z
      .number()
      .int()
      .positive()
      .max(256 * 1024)
      .optional(),
  });

export const ExternalReplayPayloadRangeSchema = z.object({
  eventId: z.string(),
  fieldPath: z.string(),
  offset: SafeU64Schema,
  nextOffset: SafeU64Schema,
  eof: z.boolean(),
  totalBytes: SafeU64Schema,
  text: z.string(),
});

export const ExternalReplayExportFormatSchema = z.enum([
  "json",
  "markdown",
  "orgii_session_json",
]);

export const ExternalReplayOrgiiEnvelopeSchema = z.object({
  exportedAt: z.string(),
  session: z.record(z.string(), z.unknown()),
  originalCategory: z.string(),
  specs: z.array(z.unknown()).optional(),
});

export const ExternalReplayStreamExportInput = ExternalReplayTargetInput.extend(
  {
    destinationPath: z.string().min(1),
    format: ExternalReplayExportFormatSchema,
    orgiiEnvelope: ExternalReplayOrgiiEnvelopeSchema.optional(),
  }
);

export const ExternalReplayExportResultSchema = z.object({
  destinationPath: z.string(),
  bytesWritten: SafeU64Schema,
  eventCount: SafeU64Schema,
  sha256: z.string(),
});

export const ExternalReplayCloudPrepareInput = ExternalReplayTargetInput;

export const ExternalReplayCloudManifestSchema = z.object({
  token: z.string().min(1),
  generation: z.string(),
  totalCount: SafeU64Schema,
  frozenEventCount: SafeU64Schema,
  tailEventCount: SafeU64Schema,
  frozenChainHash: z.string(),
  tailHash: z.string().nullable(),
});

export const ExternalReplayCloudReadBatchInput = z.object({
  token: z.string().min(1),
  startEventIndex: SafeU64Schema,
  endEventIndex: SafeU64Schema,
  startSegmentIndex: SafeU64Schema.optional(),
  maxBytes: z
    .number()
    .int()
    .positive()
    .max(256 * 1024)
    .optional(),
});

export const ExternalReplayCloudSegmentSchema = z.object({
  payloadGz: z.string(),
  eventCount: SafeU64Schema,
  segmentHash: z.string(),
  wireBytes: SafeU64Schema.max(256 * 1024),
});

export const ExternalReplayCloudBatchSchema = z.object({
  segments: z.array(ExternalReplayCloudSegmentSchema).max(200),
  startEventIndex: SafeU64Schema,
  nextEventIndex: SafeU64Schema,
  startSegmentIndex: SafeU64Schema,
  nextSegmentIndex: SafeU64Schema,
  eof: z.boolean(),
  serializedBytes: SafeU64Schema,
});

export const ExternalReplayCloudPrefixHashInput = z.object({
  token: z.string().min(1),
  eventCount: SafeU64Schema,
});

export const ExternalReplayCloudPrefixHashSchema = z.object({
  eventCount: SafeU64Schema,
  frozenChainHash: z.string(),
});

export const ExternalReplayCloudReleaseInput = z.object({
  token: z.string().min(1),
});

export const ExternalReplayInvalidationSchema = z.object({
  sessionId: z.string(),
  sourceId: ExternalReplaySourceIdSchema,
  generation: z.string().optional(),
});

export type ExternalReplaySourceId = z.infer<
  typeof ExternalReplaySourceIdSchema
>;
export type ExternalReplayLimits = z.infer<typeof ExternalReplayLimitsSchema>;
export type ExternalReplayCursor = z.infer<typeof ExternalReplayCursorSchema>;
export type ExternalReplayWindow = z.infer<typeof ExternalReplayWindowSchema>;
export type ExternalReplayDelta = z.infer<typeof ExternalReplayDeltaSchema>;
export type ExternalReplayHandoff = z.infer<typeof ExternalReplayHandoffSchema>;
export type ExternalReplayPayloadRange = z.infer<
  typeof ExternalReplayPayloadRangeSchema
>;
export type ExternalReplayExportFormat = z.infer<
  typeof ExternalReplayExportFormatSchema
>;
export type ExternalReplayExportResult = z.infer<
  typeof ExternalReplayExportResultSchema
>;
export type ExternalReplayOrgiiEnvelope = z.infer<
  typeof ExternalReplayOrgiiEnvelopeSchema
>;
export type ExternalReplayInvalidation = z.infer<
  typeof ExternalReplayInvalidationSchema
>;
export type ExternalReplayCloudManifest = z.infer<
  typeof ExternalReplayCloudManifestSchema
>;
export type ExternalReplayCloudBatch = z.infer<
  typeof ExternalReplayCloudBatchSchema
>;
export type ExternalReplayCloudPrefixHash = z.infer<
  typeof ExternalReplayCloudPrefixHashSchema
>;
