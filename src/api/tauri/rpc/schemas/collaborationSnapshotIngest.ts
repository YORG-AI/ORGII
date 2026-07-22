import { z } from "zod/v4";

const SafeU64Schema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/i);

const ImportedSnapshotSessionIdSchema = z
  .string()
  .refine(
    (value) =>
      value.startsWith("imported-session-") &&
      value.length > "imported-session-".length,
    "Snapshot cursor target must be an imported-session"
  );

export const CollaborationSnapshotCursorSchema = z.object({
  epoch: SafeU64Schema,
  frozenSeq: SafeU64Schema,
  count: SafeU64Schema,
  frozenCount: SafeU64Schema,
  tailHash: Sha256Schema.nullable(),
});

export const CollaborationSnapshotWireCursorSchema = z.discriminatedUnion(
  "direction",
  [
    z.object({
      direction: z.literal("forward"),
      afterSeq: SafeU64Schema,
      throughSeq: SafeU64Schema.optional(),
    }),
    z.object({
      direction: z.literal("backward"),
      beforeSeq: SafeU64Schema.positive().optional(),
    }),
  ]
);

export const CollaborationSnapshotWireSchema = z.object({
  seq: SafeU64Schema,
  payloadGz: z.string(),
  eventCount: SafeU64Schema,
  segmentHash: Sha256Schema,
});

export const CollaborationSnapshotIngestBeginRequestSchema = z
  .object({
    localSessionId: z
      .string()
      .refine(
        (value) =>
          (value.startsWith("imported-session-") &&
            value.length > "imported-session-".length) ||
          (value.startsWith("agentsession-") &&
            value.length > "agentsession-".length),
        "Snapshot target must be an imported-session or agentsession"
      ),
    epoch: SafeU64Schema,
    expectedCount: SafeU64Schema,
    expectedFrozenSeq: SafeU64Schema,
    tailHash: Sha256Schema.nullable(),
    replace: z.boolean(),
    previous: CollaborationSnapshotCursorSchema.optional(),
  })
  .superRefine((value, context) => {
    if (!value.replace && value.previous === undefined) {
      context.addIssue({
        code: "custom",
        message: "Incremental snapshot ingest requires a previous cursor",
        path: ["previous"],
      });
    }
    if (
      value.localSessionId.startsWith("agentsession-") &&
      (!value.replace || value.previous !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Native fork snapshot ingest must be an unconditional full replacement",
        path: ["replace"],
      });
    }
  });

export const CollaborationSnapshotIngestBeginInputSchema = z.object({
  request: CollaborationSnapshotIngestBeginRequestSchema,
});

export const CollaborationSnapshotIngestBeginResultSchema = z.object({
  token: z.uuid(),
});

export const CollaborationSnapshotIngestGetCursorInputSchema = z.object({
  request: z.object({
    localSessionId: ImportedSnapshotSessionIdSchema,
  }),
});

export const CollaborationSnapshotSecondaryProbeInputSchema = z.object({
  request: z.object({
    sessionId: z
      .string()
      .refine(
        (value) =>
          value.startsWith("agentsession-") &&
          value.length > "agentsession-".length,
        "Secondary snapshot target must be an agentsession"
      ),
  }),
});

export const CollaborationSnapshotIngestPageRequestSchema = z
  .object({
    token: z.uuid(),
    epoch: SafeU64Schema,
    frozenSeq: SafeU64Schema,
    count: SafeU64Schema,
    tailHash: Sha256Schema.nullable(),
    cursor: CollaborationSnapshotWireCursorSchema,
    nextCursor: CollaborationSnapshotWireCursorSchema.nullable(),
    tailIncluded: z.boolean(),
    hasMore: z.boolean(),
    returnedWireBytes: SafeU64Schema.max(4 * 1024 * 1024),
    segments: z.array(CollaborationSnapshotWireSchema).max(200),
  })
  .superRefine((value, context) => {
    if (value.hasMore !== (value.nextCursor !== null)) {
      context.addIssue({
        code: "custom",
        message: "hasMore and nextCursor must agree",
        path: ["nextCursor"],
      });
    }
  });

export const CollaborationSnapshotIngestPageInputSchema = z.object({
  request: CollaborationSnapshotIngestPageRequestSchema,
});

export const CollaborationSnapshotIngestProgressSchema = z.object({
  acceptedPhysicalRows: SafeU64Schema,
  acceptedLogicalEvents: SafeU64Schema,
  complete: z.boolean(),
});

export const CollaborationSnapshotIngestTokenInputSchema = z.object({
  request: z.object({ token: z.uuid() }),
});

export const CollaborationSnapshotIngestCommitResultSchema = z.object({
  localSessionId: z
    .string()
    .refine(
      (value) =>
        value.startsWith("imported-session-") ||
        value.startsWith("agentsession-"),
      "Snapshot target must be an imported-session or agentsession"
    ),
  epoch: SafeU64Schema,
  frozenSeq: SafeU64Schema,
  eventCount: SafeU64Schema,
  frozenEventCount: SafeU64Schema,
  tailHash: Sha256Schema.nullable(),
  handoffItems: z.array(z.string().max(1_200)).max(80),
  handoffScannedBytes: SafeU64Schema.max(4 * 1024 * 1024),
  handoffScannedEvents: SafeU64Schema,
});

export type CollaborationSnapshotCursor = z.infer<
  typeof CollaborationSnapshotCursorSchema
>;
export type CollaborationSnapshotWireCursor = z.infer<
  typeof CollaborationSnapshotWireCursorSchema
>;
export type CollaborationSnapshotWire = z.infer<
  typeof CollaborationSnapshotWireSchema
>;
export type CollaborationSnapshotIngestBeginRequest = z.infer<
  typeof CollaborationSnapshotIngestBeginRequestSchema
>;
export type CollaborationSnapshotIngestGetCursorRequest = z.infer<
  typeof CollaborationSnapshotIngestGetCursorInputSchema
>["request"];
export type CollaborationSnapshotIngestPageRequest = z.infer<
  typeof CollaborationSnapshotIngestPageRequestSchema
>;
export type CollaborationSnapshotIngestProgress = z.infer<
  typeof CollaborationSnapshotIngestProgressSchema
>;
export type CollaborationSnapshotIngestCommitResult = z.infer<
  typeof CollaborationSnapshotIngestCommitResultSchema
>;
