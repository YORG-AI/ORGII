import { z } from "zod/v4";

const Id = z.string().trim().min(1).max(4_096);
const Value = z.string().trim().min(1).max(32_768);
const RollReason = z.string().trim().min(1).max(512);
const Revision = z.number().int().nonnegative().safe();
const EventCount = z.number().int().nonnegative().safe();
const Sha256 = z.string().regex(/^[0-9a-f]{64}$/u);

interface CheckpointFields {
  sourceCheckpointId?: string | null;
  sourceCheckpointSha256?: string | null;
  sourceEventCount: number;
  sourceTipEventId?: string | null;
}

interface CustomRefinementContext {
  addIssue(issue: {
    code: "custom";
    path: PropertyKey[];
    message: string;
  }): void;
}

function refineCheckpoint(
  value: CheckpointFields,
  context: CustomRefinementContext
): void {
  const hasId = Boolean(value.sourceCheckpointId);
  const hasDigest = Boolean(value.sourceCheckpointSha256);
  if (hasId !== hasDigest) {
    context.addIssue({
      code: "custom",
      path: [hasId ? "sourceCheckpointSha256" : "sourceCheckpointId"],
      message: "checkpoint id and SHA-256 must be present together",
    });
  }
  if (value.sourceEventCount > 0 && !hasId) {
    context.addIssue({
      code: "custom",
      path: ["sourceEventCount"],
      message: "a non-empty source requires an exact checkpoint",
    });
  }
  if (value.sourceEventCount === 0 && value.sourceTipEventId) {
    context.addIssue({
      code: "custom",
      path: ["sourceTipEventId"],
      message: "an empty source cannot have a tip event",
    });
  }
}

export const ConversationExecutionEpisodeStateSchema = z.enum([
  "prepared",
  "materializing",
  "active",
  "retired",
  "failed",
]);

export const ConversationExecutionFinalStateSchema = z.enum([
  "retired",
  "failed",
]);

export const ConversationExecutionKeySchema = z.object({
  executorScope: Id,
  conversationRootKey: Id,
});

export const ConversationSourceCheckpointSchema = z
  .object({
    sourceCheckpointId: Id.nullable().optional(),
    sourceCheckpointSha256: Sha256.nullable().optional(),
    sourceEventCount: EventCount,
    sourceTipEventId: Id.nullable().optional(),
  })
  .superRefine(refineCheckpoint);

export const ConversationRuntimeProfileSchema = z.object({
  runtimeCategory: Id,
  runtimeId: Id,
  agentId: Id.nullable().optional(),
  accountId: Id.nullable().optional(),
  modelId: Value.nullable().optional(),
  workspaceLocator: Value.nullable().optional(),
  workspaceFingerprint: Value.nullable().optional(),
  executionProfileFingerprint: Value,
});

export const ConversationExecutionRecordSchema =
  ConversationExecutionKeySchema.extend({
    activeEpisodeId: Id.nullable(),
    candidateEpisodeId: Id.nullable(),
    revision: Revision,
    updatedAt: z.string(),
  });

export const ConversationExecutionEpisodeSchema = z
  .object({
    ...ConversationExecutionKeySchema.shape,
    episodeId: Id,
    runnerSessionId: Id,
    nativeSessionId: Id,
    state: ConversationExecutionEpisodeStateSchema,
    ...ConversationSourceCheckpointSchema.shape,
    ...ConversationRuntimeProfileSchema.shape,
    bootstrapIntentId: Id,
    verifiedMaterializationSha256: Sha256.nullable(),
    activationReceiptId: Id.nullable(),
    supersedesEpisodeId: Id.nullable(),
    rollReason: RollReason.nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .superRefine((value, context) => {
    refineCheckpoint(value, context);
    if (
      value.state === "active" &&
      (!value.verifiedMaterializationSha256 || !value.activationReceiptId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message:
          "active requires independent materialization proof and first-turn acceptance",
      });
    }
    if (
      (value.state === "retired" || value.state === "failed") &&
      !value.rollReason
    ) {
      context.addIssue({
        code: "custom",
        path: ["rollReason"],
        message: "a final episode requires a roll reason",
      });
    }
  });

export const ConversationExecutionSnapshotSchema = z.object({
  execution: ConversationExecutionRecordSchema,
  episodes: z.array(ConversationExecutionEpisodeSchema).max(16),
});

export const ConversationExecutionMutationResultSchema = z.object({
  applied: z.boolean(),
  snapshot: ConversationExecutionSnapshotSchema,
});

export const ConversationRunnerRegistrationSchema = z.object({
  runnerSessionId: Id,
  executorScope: Id,
  conversationRootKey: Id,
  episodeId: Id,
  terminal: z.boolean(),
  registeredAt: z.string(),
  terminalAt: z.string().nullable(),
  updatedAt: z.string(),
});

export const ConversationRunnerMutationResultSchema = z.object({
  applied: z.boolean(),
  registration: ConversationRunnerRegistrationSchema.nullable(),
});

export const ConversationRunnerPageSchema = z.object({
  runnerSessionIds: z.array(Id).max(500),
  nextCursor: Id.nullable(),
});

const Request = <T extends z.ZodType>(request: T) => z.object({ request });

export const ConversationExecutionGetInput = Request(
  ConversationExecutionKeySchema
);

const CandidateSchema = z
  .object({
    ...ConversationExecutionKeySchema.shape,
    expectedRevision: Revision,
    episodeId: Id,
    runnerSessionId: Id,
    nativeSessionId: Id,
    bootstrapIntentId: Id,
    ...ConversationSourceCheckpointSchema.shape,
    ...ConversationRuntimeProfileSchema.shape,
  })
  .superRefine((value, context) => {
    refineCheckpoint(value, context);
  });

export const ConversationExecutionPrepareCandidateInput =
  Request(CandidateSchema);

export const ConversationExecutionBeginMaterializationInput = Request(
  ConversationExecutionKeySchema.extend({
    expectedRevision: Revision,
    expectedCandidateEpisodeId: Id,
    runnerSessionId: Id,
    nativeSessionId: Id,
    bootstrapIntentId: Id,
  })
);

export const ConversationExecutionActivateCandidateInput = Request(
  ConversationExecutionKeySchema.extend({
    expectedRevision: Revision,
    expectedActiveEpisodeId: Id.nullable(),
    expectedCandidateEpisodeId: Id,
    runnerSessionId: Id,
    nativeSessionId: Id,
    bootstrapIntentId: Id,
    verifiedMaterializationSha256: Sha256,
    activationReceiptId: Id,
  })
);

export const ConversationExecutionAbortCandidateInput = Request(
  ConversationExecutionKeySchema.extend({
    expectedRevision: Revision,
    expectedCandidateEpisodeId: Id,
    runnerSessionId: Id,
    finalState: ConversationExecutionFinalStateSchema,
    rollReason: RollReason,
  })
);

export const ConversationExecutionAdvanceCheckpointInput = Request(
  z
    .object({
      ...ConversationExecutionKeySchema.shape,
      expectedRevision: Revision,
      episodeId: Id,
      runnerSessionId: Id,
      ...ConversationSourceCheckpointSchema.shape,
    })
    .superRefine((value, context) => {
      refineCheckpoint(value, context);
    })
);

export const ConversationExecutionRetireActiveInput = Request(
  ConversationExecutionKeySchema.extend({
    expectedRevision: Revision,
    expectedActiveEpisodeId: Id,
    runnerSessionId: Id,
    finalState: ConversationExecutionFinalStateSchema,
    rollReason: RollReason,
  })
);

export const ConversationRunnerIdentityInput = Request(
  z.object({
    runnerSessionId: Id,
    executorScope: Id,
    conversationRootKey: Id,
    episodeId: Id,
  })
);

export const ConversationRunnerPageInput = Request(
  z.object({
    afterRunnerSessionId: Id.nullable().optional(),
    limit: z.number().int().min(1).max(500),
  })
);

export const ConversationRunnerCleanupCandidatesInput = Request(
  z.object({
    terminalBefore: z.string().datetime({ offset: true }),
    limit: z.number().int().min(1).max(500),
  })
);

export const ConversationExecutionImportLegacyRunnersInput = Request(
  ConversationExecutionKeySchema.extend({
    runners: z
      .array(
        z.object({
          runnerSessionId: Id,
          episodeId: Id,
          terminal: z.boolean(),
        })
      )
      .min(1)
      .max(4_096),
  })
);

export type ConversationExecutionKey = z.infer<
  typeof ConversationExecutionKeySchema
>;
export type ConversationExecutionSnapshot = z.infer<
  typeof ConversationExecutionSnapshotSchema
>;
export type ConversationExecutionMutationResult = z.infer<
  typeof ConversationExecutionMutationResultSchema
>;
export type ConversationRunnerRegistration = z.infer<
  typeof ConversationRunnerRegistrationSchema
>;
export type ConversationRunnerPage = z.infer<
  typeof ConversationRunnerPageSchema
>;
