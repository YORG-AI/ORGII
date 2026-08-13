import { z } from "zod/v4";

import type {
  AgentStatusInfo,
  DeleteSessionReceipt,
  FileResolution,
  HousekeeperContextCompactionState,
  ManualCompactResult,
  PendingQuestion,
  RevertResult,
  SessionFileRecord,
  SessionInfo,
  SessionMessage,
  SessionMeta,
  SnapshotRecord,
  TodoItem,
} from "@src/api/tauri/agent/types";

const JsonRecordSchema = z.record(z.string(), z.unknown());

export const SessionIdInput = z.object({
  sessionId: z.string(),
});

export const DeleteSessionReceiptSchema = z.object({
  deletedSessionIds: z.array(z.string()),
}) as z.ZodType<DeleteSessionReceipt, DeleteSessionReceipt>;

/**
 * Input for `agent_session_manual_compact` — optional free-form user
 * instructions steer what the summarizer should focus on.
 */
export const ManualCompactInput = z.object({
  sessionId: z.string(),
  instructions: z.string().optional(),
});

export const HousekeeperContextCompactionEnabledInput = z.object({
  sessionId: z.string(),
  enabled: z.boolean(),
});

export const SessionRequestIdInput = z.object({
  sessionId: z.string(),
  requestId: z.string(),
});

/**
 * Input for `agent_secret_capture_submit` — pairs the request id with the
 * plaintext value the user typed into `SecretCaptureModal`. The value is
 * forwarded straight to Rust and never persisted on the FE side.
 */
export const SecretCaptureSubmitInput = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  value: z.string(),
});

/**
 * Input for `agent_secret_capture_discard` — the agent retired a captured
 * secret early. We pass the raw token here; the broker also accepts the
 * templated `{{secret:<token>}}` form but the FE always sends the bare id.
 */
export const SecretCaptureDiscardInput = z.object({
  sessionId: z.string(),
  token: z.string(),
});

export const SessionInfoSchema = z.object({
  sessionId: z.string(),
  agentId: z.string(),
  agentName: z.string(),
  isSingleton: z.boolean(),
}) as z.ZodType<SessionInfo, SessionInfo>;

export const ManualCompactResultSchema = z.object({
  status: z.enum([
    "compacted",
    "too_short",
    "already_compact",
    "busy",
    "no_runtime",
    "channel_attached",
    "failed",
  ]),
  message: z.string().optional(),
  messagesBefore: z.number().optional(),
  messagesAfter: z.number().optional(),
  tokensBefore: z.number().optional(),
  tokensAfter: z.number().optional(),
  boundary: z
    .object({
      id: z.string(),
      content: z.string(),
      createdAt: z.string(),
    })
    .optional(),
}) as z.ZodType<ManualCompactResult, ManualCompactResult>;

export const HousekeeperContextCompactionStateSchema = z.object({
  enabled: z.boolean(),
  status: z.enum([
    "disabled",
    "idle",
    "running",
    "complete",
    "error",
    "unavailable",
    "busy",
  ]),
  coveredMessages: z.number(),
  sourceTokens: z.number(),
  summaryTokens: z.number(),
  lastRunAt: z.string().optional(),
  lastError: z.string().optional(),
  message: z.string().optional(),
}) as z.ZodType<
  HousekeeperContextCompactionState,
  HousekeeperContextCompactionState
>;

export const SessionMessageSchema = z
  .object({
    id: z.string(),
    role: z.string(),
    content: z.string(),
    toolName: z.string().optional(),
    toolInput: z.string().optional(),
    createdAt: z.string(),
    compactFromSequence: z.number().nullable().optional(),
  })
  .catchall(z.unknown()) as z.ZodType<SessionMessage, SessionMessage>;

export const SessionMetaSchema = z
  .object({
    sessionId: z.string(),
    name: z.string().optional(),
    status: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    workspacePath: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    accountId: z.string().nullable().optional(),
    orgId: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    projectName: z.string().nullable().optional(),
    workItemId: z.string().nullable().optional(),
    projectSlug: z.string().nullable().optional(),
    agentDefinitionId: z.string().nullable().optional(),
    userInput: z.string().nullable().optional(),
    totalTokens: z.number().optional(),
    errorMessage: z.string().nullable().optional(),
  })
  .catchall(z.unknown()) as unknown as z.ZodType<SessionMeta, SessionMeta>;

export const CancelReasonSchema = z.enum([
  "user_stop",
  "force_send",
  "org_pause",
  "programmatic_shutdown",
  "session_eviction",
  "mode_switch_abort",
]);

export const CancelSessionInput = z.object({
  sessionId: z.string(),
  reason: CancelReasonSchema,
});

export const TruncateAfterMessageInput = z.object({
  sessionId: z.string(),
  createdAt: z.string(),
  revertFiles: z.boolean(),
  messageId: z.string().optional(),
});

export const CheckSnapshotChangesInput = z.object({
  sessionId: z.string(),
  createdAt: z.string(),
});

export const UpdateSessionStatusInput = z.object({
  sessionId: z.string(),
  status: z.string(),
});

export const SaveSessionInput = z.object({
  session: SessionMetaSchema,
});

export const LinkSessionToWorkItemInput = z.object({
  sessionId: z.string(),
  orgId: z.string().optional(),
  projectSlug: z.string(),
  workItemId: z.string(),
  agentRole: z.string().optional(),
});

export const TrackSessionAsProjectResult = z.object({
  productMode: z.string(),
  agentExecMode: z.string(),
  workItemId: z.string().nullable().optional(),
});

export const QuestionResponseInput = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  answers: z.array(z.array(z.string())),
});

export const PermissionResponseInput = z.object({
  sessionId: z.string(),
  requestId: z.string(),
  response: z.enum(["allow", "deny", "always_allow"]),
  toolName: z.string().optional(),
  toolArgs: JsonRecordSchema.optional(),
});

export const ModeSwitchResponseInput = z.object({
  sessionId: z.string(),
  choice: z.enum(["switch", "skip"]),
  targetMode: z.string().optional(),
});

export const PendingQuestionSchema = z
  .object({
    id: z.string(),
    question: z.string(),
    options: z.array(z.string()).optional(),
    timestamp: z.string(),
  })
  .catchall(z.unknown()) as z.ZodType<PendingQuestion, PendingQuestion>;

export const PendingQuestionsOutput = z.object({
  pendingQuestions: z.array(PendingQuestionSchema),
});

export const PendingPlanApprovalSchema = z
  .object({
    sessionId: z.string(),
    planPath: z.string(),
    planTitle: z.string(),
    planContent: z.string(),
    toolCallId: z.string().optional(),
    planId: z.string().optional(),
    planRevisionId: z.string().optional(),
    originToolCallId: z.string().optional(),
    autoApproveAt: z.number().nullable().optional(),
  })
  .nullable();

export const PlanApprovalResponseInput = z.object({
  sessionId: z.string(),
  choice: z.enum(["approve", "approve_with_edits", "reject"]),
  editedContent: z.string().optional(),
  model: z.string().nullable(),
  accountId: z.string().nullable(),
  workspacePath: z.string().nullable(),
});

export const SessionFileRecordSchema = z
  .object({
    path: z.string(),
    count: z.number(),
    additions: z.number(),
    deletions: z.number(),
    lineCount: z.number(),
  })
  .catchall(z.unknown()) as z.ZodType<SessionFileRecord, SessionFileRecord>;

export const SessionFilesSchema = z.array(SessionFileRecordSchema);

export const SnapshotRecordSchema = z.object({
  sessionId: z.string(),
  toolCallId: z.string(),
  hash: z.string(),
  createdAt: z.string(),
}) as z.ZodType<SnapshotRecord, SnapshotRecord>;

export const RevertInput = z.object({
  createdAt: z.string(),
  sessionId: z.string(),
});

export const RestoreSnapshotInput = z.object({
  sessionId: z.string(),
  snapshotId: z.string(),
});

export const RevertResultSchema = z
  .object({
    reverted: z.number(),
    restored: z.number(),
    deleted: z.number(),
    skipped: z.number(),
    failed: z.number(),
    createdAt: z.string().optional(),
    redoAnchors: z
      .array(
        z.object({
          sessionId: z.string(),
          snapshotId: z.string(),
          createdAt: z.string(),
        })
      )
      .optional(),
  })
  .catchall(z.unknown()) as z.ZodType<RevertResult, RevertResult>;

export const RevertFileReviewInput = z.object({
  workspacePath: z.string(),
  filePath: z.string(),
  sessionId: z.string(),
  createdAt: z.string(),
});

export const RevertFileInput = z.object({
  workspacePath: z.string(),
  snapshotHash: z.string(),
  filePath: z.string(),
  sessionId: z.string(),
});

export const TodoItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  activeForm: z.string().optional(),
  status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
}) as z.ZodType<TodoItem, TodoItem>;

export const FileResolutionInput = z.object({
  sessionId: z.string(),
  filePath: z.string(),
  resolution: z.enum(["accepted", "rejected", "reverted"]),
});

export const FileResolutionSchema = z.object({
  path: z.string(),
  resolution: z.enum(["accepted", "rejected", "reverted"]),
}) as z.ZodType<FileResolution, FileResolution>;

export const AgentStatusInfoSchema = z.object({
  running: z.boolean(),
  gatewayRunning: z.boolean(),
  activeSessions: z.number(),
  sessionIds: z.array(z.string()),
}) as z.ZodType<AgentStatusInfo, AgentStatusInfo>;

const SessionLaunchParamsSchema = z
  .object({
    category: z.enum(["rust_agent", "cli_agent"]),
    content: z.string(),
    workspacePath: z.string().optional(),
    keySource: z.string().optional(),
    accountId: z.string().optional(),
    model: z.string().optional(),
    nativeHarnessType: z.string().optional(),
    platform: z.string().optional(),
    branch: z.string().optional(),
    worktreeBaseRef: z.string().optional(),
    hostedToken: z.string().optional(),
    tier: z.string().optional(),
    name: z.string().optional(),
    background: z.boolean().optional(),
    images: z.array(z.string()).optional(),
    ideContext: z.unknown().optional(),
    agentDefinitionId: z.string().optional(),
    agentOrgId: z.string().optional(),
    agentOrgMemberOverrides: z.record(z.string(), z.unknown()).optional(),
    applyAgentOrgMemberOverridesForFuture: z.boolean().optional(),
    isolate: z.boolean().optional(),
    mode: z.string().optional(),
    orgId: z.string().optional(),
    projectId: z.string().optional(),
    projectName: z.string().optional(),
    workItemId: z.string().optional(),
    productMode: z.string().optional(),
    agentRole: z.string().optional(),
    worktreePath: z.string().optional(),
    projectSlug: z.string().optional(),
    parentSessionId: z.string().optional(),
    additionalDirectories: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((params, context) => {
    if ((params.isolate || params.worktreePath) && !params.workspacePath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Worktree mode requires workspacePath",
        path: ["workspacePath"],
      });
    }
    if (params.isolate && params.worktreePath) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "isolate and worktreePath are mutually exclusive",
        path: ["worktreePath"],
      });
    }
    if (params.worktreeBaseRef && !params.isolate) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "worktreeBaseRef requires isolate=true",
        path: ["worktreeBaseRef"],
      });
    }
  });

export const SessionLaunchInput = z.object({
  params: SessionLaunchParamsSchema,
});

export const SessionLaunchResultSchema = z
  .object({
    sessionId: z.string(),
    category: z.string(),
    name: z.string(),
    status: z.string(),
    createdAt: z.string(),
    userInput: z.string(),
    workspacePath: z.string().nullable().optional(),
    branch: z.string().nullable().optional(),
    background: z.boolean(),
    model: z.string().nullable().optional(),
    cliAgentType: z.string().nullable().optional(),
    accountId: z.string().nullable().optional(),
    agentOrgId: z.string().nullable().optional(),
    agentOrgRunId: z.string().nullable().optional(),
    orgId: z.string().nullable().optional(),
    projectId: z.string().nullable().optional(),
    projectName: z.string().nullable().optional(),
    projectSlug: z.string().nullable().optional(),
    workItemId: z.string().nullable().optional(),
    agentRole: z.string().nullable().optional(),
    productMode: z.string().nullable().optional(),
    worktreePath: z.string().nullable().optional(),
    worktreeBranch: z.string().nullable().optional(),
    baseRef: z.string().nullable().optional(),
  })
  .catchall(z.unknown());

export const WingmanStartInput = z.object({
  sessionId: z.string(),
  mission: z.string(),
  monitorIndex: z.number().optional(),
});

export const WingmanDesktopControlTestInput = z.object({
  monitorIndex: z.number().optional(),
});

export const WingmanMonitorSchema = z.object({
  index: z.number(),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  workX: z.number(),
  workY: z.number(),
  workWidth: z.number(),
  workHeight: z.number(),
  scaleFactor: z.number(),
  isPrimary: z.boolean(),
});

export const AdeActionResultInput = z.object({
  correlationId: z.string(),
  success: z.boolean(),
  message: z.string(),
  data: z.unknown().optional(),
});
