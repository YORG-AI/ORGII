import { invokeTauri } from "@src/util/platform/tauri/init";

import type { DeleteSessionReceipt } from "./types";

export const AGENT_ORG_USER_SENDER_ID = "_user" as const;

export const AGENT_ORG_TASK_STATUS = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type AgentOrgTaskStatus =
  (typeof AGENT_ORG_TASK_STATUS)[keyof typeof AGENT_ORG_TASK_STATUS];

export function isAgentOrgTaskTerminalStatus(
  status: AgentOrgTaskStatus
): boolean {
  return (
    status === AGENT_ORG_TASK_STATUS.COMPLETED ||
    status === AGENT_ORG_TASK_STATUS.FAILED ||
    status === AGENT_ORG_TASK_STATUS.CANCELLED
  );
}

export function isAgentOrgTaskOpenStatus(status: AgentOrgTaskStatus): boolean {
  return (
    status === AGENT_ORG_TASK_STATUS.PENDING ||
    status === AGENT_ORG_TASK_STATUS.IN_PROGRESS
  );
}

export function agentOrgTaskStatusSatisfiesDependency(
  status: AgentOrgTaskStatus
): boolean {
  return status === AGENT_ORG_TASK_STATUS.COMPLETED;
}

export interface AgentOrgMemberIntervention {
  interventionReceiptId: string;
  orgRunId: string;
  memberId: string;
  agentId: string;
  sessionId: string;
  status: "yield_requested" | "active" | "return_requested";
  sourceEventId: string;
  originalTaskId?: string | null;
  originalTurnIntentId?: string | null;
  queuedUserDirectedCount: number;
  enteredAt: string;
  lastUserActivityAt: string;
  yieldRequestedAt?: string | null;
  yieldReleasedAt?: string | null;
  yieldTimedOutAt?: string | null;
  failureReason?: string | null;
  clearedAt?: string | null;
}

export type ReturnToWorkOutcome =
  | "restored_task"
  | "cleared_paused"
  | "cleared_idle"
  | "no_longer_needed"
  | "already_applied";

export type AppliedReturnToWorkOutcome = Exclude<
  ReturnToWorkOutcome,
  "already_applied"
>;

export interface ReturnToWorkResult {
  outcome: ReturnToWorkOutcome;
  appliedOutcome: AppliedReturnToWorkOutcome;
  hadOriginalFormalWork: boolean;
  interventionReceiptId: string;
  requestId: string;
  clearedRevision: number;
  clearedAt: string;
  continuationTurnIntentId?: string | null;
}

export interface AgentOrgOwnerRuntime {
  agentDefinitionId?: string | null;
  cliAgentType?: string | null;
  memberId?: string | null;
  sessionId: string;
  parentSessionId?: string | null;
  status: string;
  updatedAt: string;
  intervention?: AgentOrgMemberIntervention | null;
}

export interface AgentOrgRunContextMember {
  memberId: string;
  name: string;
  role: string;
  agentId: string;
}

export interface AgentOrgRunContext {
  runId: string;
  orgId: string;
  orgName: string;
  orgRole: string;
  coordinatorAgentId: string;
  coordinatorName: string;
  coordinatorRole: string;
  members: AgentOrgRunContextMember[];
  planApprovalPolicy: "coordinator" | "user" | "automatic";
  /** Session ID of the coordinator (root) session. Used to navigate directly
   *  to the coordinator's chat history when the run is paused or the user
   *  is viewing a different member. `null` only before the first coordinator
   *  session has been materialized. */
  rootSessionId?: string | null;
}

export interface AgentOrgRunMemberView {
  memberId: string;
  name: string;
  role: string;
  agentId: string;
  isCoordinator: boolean;
  writerCapable: boolean;
  sessionRuntime?: AgentOrgOwnerRuntime | null;
  unreadInboxCount: number;
  inboxActivityCount: number;
  activeTaskCount: number;
  pendingTaskCount: number;
  inProgressTaskCount: number;
  completedTaskCount: number;
  queuedUserDirectedCount: number;
  activity?: {
    kind: "yielding" | "user_intervention" | "side_quest" | "yield_timeout";
    source: "direct_member";
    interventionReceiptId: string;
  } | null;
  intervention?: AgentOrgMemberIntervention | null;
}

export const AGENT_ORG_RUN_STATUS = {
  STARTING: "starting",
  RUNNING: "running",
  PAUSED: "paused",
  IDLE: "idle",
  FAILED: "failed",
  ARCHIVED: "archived",
} as const;

export type AgentOrgRunStatus =
  (typeof AGENT_ORG_RUN_STATUS)[keyof typeof AGENT_ORG_RUN_STATUS];

export const AGENT_ORG_RUN_PHASE = {
  STARTING: "starting",
  COORDINATING: "coordinating",
  DISPATCHING: "dispatching",
  MEMBERS_WORKING: "members_working",
  WAITING: "waiting",
  AWAITING_PLAN_APPROVAL: "awaiting_plan_approval",
  FINALIZING: "finalizing",
  DRAINING: "draining",
  PAUSED: "paused",
  IDLE: "idle",
  FAILED: "failed",
  ARCHIVED: "archived",
} as const;

export type AgentOrgRunPhase =
  (typeof AGENT_ORG_RUN_PHASE)[keyof typeof AGENT_ORG_RUN_PHASE];

export type AgentOrgCoordinatorWorkState =
  | "active"
  | "waiting_for_org_event"
  | "inactive";

export type AgentOrgRunCompletionOutcome = "delivered" | "cancelled" | "failed";

export interface AgentOrgRunCompletionView {
  state: "none" | "needs_attention" | "certified";
  outcome?: AgentOrgRunCompletionOutcome | null;
  certificateId?: string | null;
  workRevision?: number | null;
}

export type AgentOrgFinalSummaryStatus =
  | "pending"
  | "running"
  | "persisting"
  | "persisted"
  | "failed";

export interface AgentOrgFinalSummaryReceipt {
  receiptId: string;
  orgRunId: string;
  activationGeneration: number;
  certificateId: string;
  evidenceDigest: string;
  attempt: number;
  status: AgentOrgFinalSummaryStatus;
  coordinatorSessionId: string;
  turnIntentId?: string | null;
  startedAt?: string | null;
  terminalAt?: string | null;
  eventId?: string | null;
  typedError?: string | null;
  canRetry: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentOrgFormalActivity {
  pendingCount: number;
  materializedCount: number;
  pendingReceiptIds: string[];
  coordinatorObserving: boolean;
}

export interface AgentOrgRunView {
  context: AgentOrgRunContext;
  runStatus: AgentOrgRunStatus;
  runPhase: AgentOrgRunPhase;
  coordinatorWorkState: AgentOrgCoordinatorWorkState;
  completion: AgentOrgRunCompletionView;
  finalSummary?: AgentOrgFinalSummaryReceipt | null;
  formalActivity: AgentOrgFormalActivity;
  pauseHandoff?: AgentOrgPauseHandoffSummary | null;
  archiveTeardown?: AgentOrgArchiveTeardownSummary | null;
  currentMemberId?: string | null;
  members: AgentOrgRunMemberView[];
  tasks: AgentOrgTask[];
  executionHandoffs: AgentOrgTaskExecutionHandoffReceipt[];
  taskOverview: AgentOrgRunTaskOverview;
  inbox: AgentOrgInboxPreviewRow[];
  /** All unread durable Inbox history, including non-actionable lifecycle records. */
  unreadInboxCount: number;
  /** Unread Inbox work that can still affect Team runtime convergence. */
  blockingUnreadInboxCount: number;
  planRevisions: AgentOrgPlanRevisionSummary[];
}

export interface AgentOrgPauseHandoffSummary {
  episodeId: string;
  pauseGeneration: number;
  totalCount: number;
  drainingCount: number;
  timedOutCount: number;
}

export interface AgentOrgArchiveTeardownSummary {
  receiptId: string;
  status: "pending" | "quiesced" | "retained_runtime";
  attemptCount: number;
  retainedRuntimeCount: number;
  deadlineAt: string;
}

export interface ArchiveRunOutcome {
  requestId: string;
  runId: string;
  receiptId: string;
  transitioned: boolean;
  archiveGeneration: number;
  archivedAt: string;
  cancellations: {
    tasks: number;
    turns: number;
    inboxDeliveries: number;
    planApprovals: number;
    interventions: number;
    pauseContinuations: number;
  };
  teardown: AgentOrgArchiveTeardownSummary;
}

export interface PauseRunOutcome {
  requestId: string;
  runId: string;
  episodeId: string;
  transitioned: boolean;
  pauseGeneration: number;
  capturedTurnCount: number;
  drainingTurnCount: number;
  timedOutTurnCount: number;
}

export interface ResumeRunOutcome {
  requestId: string;
  runId: string;
  episodeId: string;
  transitioned: boolean;
  resumeGeneration: number;
  continuationCount: number;
  skippedCount: number;
}

export interface AgentOrgRunTaskOverview {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  failed: number;
  cancelled: number;
  corrupt: number;
  visible: number;
  truncated: boolean;
}

export interface AgentOrgPlanTaskOutputRef {
  taskId: string;
  planRevisionId: string;
  producedByMemberId: string;
  producedAt: string;
}

export interface AgentOrgPlanRevisionSummary {
  approvalId: string;
  planRevisionId: string;
  revisionNumber: number;
  previousPlanRevisionId?: string | null;
  requestId: string;
  orgRunId: string;
  sourceTaskId: string;
  sourceMemberId: string;
  sourceSessionId: string;
  sourceTurnIntentId: string;
  rootSessionId: string;
  policy: "coordinator" | "user" | "automatic";
  status:
    | "pending"
    | "approved"
    | "changes_requested"
    | "superseded"
    | "cancelled";
  planTitle: string;
  planContentBytes: number;
  contentDigest: string;
  decisionBy?: "user" | "coordinator" | "automatic" | "system" | null;
  feedback?: string | null;
  taskOutput?: AgentOrgPlanTaskOutputRef | null;
  createdAt: string;
  resolvedAt?: string | null;
}

/** @deprecated Use AgentOrgPlanRevisionSummary. */
export type AgentOrgPlanApprovalSummary = AgentOrgPlanRevisionSummary;

export interface AgentOrgPlanRevision {
  approvalId: string;
  planRevisionId: string;
  revisionNumber: number;
  previousPlanRevisionId?: string | null;
  requestId: string;
  orgRunId: string;
  sourceTaskId: string;
  sourceMemberId: string;
  sourceSessionId: string;
  sourceTurnIntentId: string;
  rootSessionId: string;
  policy: "coordinator" | "user" | "automatic";
  status:
    | "pending"
    | "approved"
    | "changes_requested"
    | "superseded"
    | "cancelled";
  planTitle: string;
  planPath: string;
  planContent: string;
  contentDigest: string;
  decisionBy?: "user" | "coordinator" | "automatic" | "system" | null;
  feedback?: string | null;
  taskOutput?: AgentOrgPlanTaskOutputRef | null;
  createdAt: string;
  resolvedAt?: string | null;
}

/** @deprecated Use AgentOrgPlanRevision. */
export type AgentOrgPlanApproval = AgentOrgPlanRevision;

export interface AgentOrgGroupDeliveryInput {
  targetMemberId: string;
  turnIntentId: string;
}

export interface AgentOrgGroupDeliveryResponse {
  targetMemberId: string;
  targetMemberName: string;
  turnIntentId: string;
  sourceInboxId: number;
  memberDispatchSequence: number;
  outcome: "accepted" | "existing";
  inboxRow: AgentOrgInboxRuntimeRow;
}

export interface AgentOrgGroupChatMessageResponse {
  deliveries: AgentOrgGroupDeliveryResponse[];
}

type AgentOrgStateChangeSubscriber = (sessionId: string) => void;

const agentOrgStateChangeSubscribers = new Set<AgentOrgStateChangeSubscriber>();

function publishAgentOrgStateChange(sessionId: string): void {
  for (const subscriber of agentOrgStateChangeSubscribers) {
    subscriber(sessionId);
  }
}

/**
 * Invalidates cached Agent Org projections after a local mutation. Backend
 * pushes cover background activity; the store keeps a slow recovery read for
 * missed events.
 */
export function subscribeAgentOrgStateChanges(
  subscriber: AgentOrgStateChangeSubscriber
): () => void {
  agentOrgStateChangeSubscribers.add(subscriber);
  return () => agentOrgStateChangeSubscribers.delete(subscriber);
}

export interface AgentOrgTask {
  id: string;
  orgRunId: string;
  subject: string;
  description: string;
  /** True when Run View carries a preview; use task_get for full content. */
  descriptionTruncated?: boolean;
  activeForm?: string | null;
  owner?: string | null;
  ownerMember?: AgentOrgRunContextMember | null;
  ownerRuntime?: AgentOrgOwnerRuntime | null;
  executionHandoff?: AgentOrgTaskExecutionHandoffReceipt | null;
  status: AgentOrgTaskStatus;
  blocks: string[];
  /** True when the polling/list projection carries only a prefix. */
  blocksTruncated?: boolean;
  blockedBy: string[];
  /** True when the polling/list projection carries only a prefix. */
  blockedByTruncated?: boolean;
  /** Backend-authoritative readiness for bounded Current/History pages. */
  dependenciesSatisfied?: boolean;
  metadata?: unknown;
  executionMode: "build" | "plan";
  output?: AgentOrgTaskOutput | null;
  outputSummary?: AgentOrgTaskOutputSummary | null;
  failureReason?: AgentOrgTaskTerminalReason | null;
  cancelReason?: AgentOrgTaskTerminalReason | null;
  createdByParticipantId?: string;
  sourceTurnIntentId?: string;
  originatingMessageId?: string | null;
  replacesTaskId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentOrgTaskOutput {
  summary: string;
  content?: string | null;
  artifactIds: string[];
  producedByMemberId: string;
  producedAt: string;
  /** Set only by the backend when a Planning Task completes for this revision. */
  planRevisionId?: string | null;
}

export interface AgentOrgTaskOutputSummary {
  summary: string;
  artifactIds: string[];
  artifactIdsTruncated: boolean;
  producedByMemberId?: string | null;
  producedAt?: string | null;
  hasContent: boolean;
}

export interface AgentOrgTaskTerminalReason {
  code: string;
  message: string;
  sourceEventId?: string | null;
}

export type AgentOrgTaskExecutionHandoffState =
  | "requested"
  | "yielding"
  | "released"
  | "timeout"
  | "unknown"
  | "failed";

export type AgentOrgTaskExecutionHandoffResolution =
  | "continue_replacement"
  | "keep_stopped"
  | "abandon_episode";

export interface AgentOrgTaskExecutionHandoffReceipt {
  id: string;
  orgRunId: string;
  activationGeneration: number;
  requestId: string;
  requestDigest: string;
  oldTaskId: string;
  oldOwnerMemberId: string;
  oldSessionId?: string | null;
  oldTurnIntentId?: string | null;
  runtimeLeaseId?: string | null;
  dialogTurnGeneration?: string | null;
  replacementTaskId?: string | null;
  state: AgentOrgTaskExecutionHandoffState;
  sloMissed: boolean;
  externalEffectUnknown: boolean;
  localEffectCount: number;
  resolutionRequestId?: string | null;
  resolutionSessionId?: string | null;
  requestedResolution?: AgentOrgTaskExecutionHandoffResolution | null;
  resolutionAttempt: number;
  resolutionRequestedAt?: string | null;
  resolution?: AgentOrgTaskExecutionHandoffResolution | null;
  requestedAt: string;
  releasedAt?: string | null;
  resolvedAt?: string | null;
  updatedAt: string;
}

export interface AgentOrgTaskHandoffRequestResult {
  task: AgentOrgTask;
  replacement?: AgentOrgTask | null;
  executionHandoff?: AgentOrgTaskExecutionHandoffReceipt | null;
}

export type AgentOrgTaskPageBucket = "current" | "history";
export type AgentOrgTaskPageDirection = "forward" | "backward";

export interface AgentOrgTaskPage {
  bucket: AgentOrgTaskPageBucket;
  status?: AgentOrgTaskStatus | null;
  tasks: AgentOrgTask[];
  hasMore: boolean;
  nextCursor?: string | null;
  previousCursor?: string | null;
}

export interface AgentOrgTaskAnnotation {
  id: string;
  orgRunId: string;
  taskId: string;
  kind: "progress" | "evidence" | "audit_note";
  body: string;
  actorKind: string;
  actorParticipantId: string;
  sourceTurnIntentId?: string | null;
  createdAt: string;
}

export interface AgentOrgTaskAnnotationPage {
  annotations: AgentOrgTaskAnnotation[];
  hasMore: boolean;
  nextCursor?: string | null;
}

export interface AgentOrgInboxPreviewRow {
  id: number;
  recipientAgentId: string;
  recipientMemberId?: string | null;
  senderAgentId: string;
  senderMemberId?: string | null;
  recipientName: string;
  senderName: string;
  displayText: string;
  orgRunId?: string | null;
  payloadKind: string;
  requestId?: string | null;
  createdAt: string;
  readAt?: string | null;
  deliveryResolution?: "cancelled" | "superseded" | null;
}

export interface AgentOrgInboxRuntimeRow extends AgentOrgInboxPreviewRow {
  /** Full durable payload returned only by explicit message/debug surfaces. */
  payloadJson: string;
}

export interface AgentOrgGroupChatHistoryRow {
  inboxId: number;
  targetMemberId?: string | null;
  targetMemberName: string;
  text: string;
  displayText: string;
  createdAt: string;
  readAt?: string | null;
  deliveryResolution?: "cancelled" | "superseded" | null;
}

export interface AgentOrgGroupChatHistoryPage {
  rows: AgentOrgGroupChatHistoryRow[];
  hasMore: boolean;
  nextBeforeId?: number | null;
}

export async function getAgentOrgSessionRunView(
  sessionId: string
): Promise<AgentOrgRunView | null> {
  return invokeTauri<AgentOrgRunView | null>("agent_org_session_run_view", {
    sessionId,
  });
}

export async function requestAgentOrgTaskHandoff(input: {
  sessionId: string;
  requestId: string;
  taskId: string;
  action: "cancel" | "reassign";
  replacementOwnerMemberId?: string | null;
}): Promise<AgentOrgTaskHandoffRequestResult> {
  const result = await invokeTauri<AgentOrgTaskHandoffRequestResult>(
    "agent_org_task_handoff_request",
    { request: input }
  );
  publishAgentOrgStateChange(input.sessionId);
  return result;
}

export async function resolveAgentOrgTaskHandoff(input: {
  sessionId: string;
  requestId: string;
  receiptId: string;
  resolution: AgentOrgTaskExecutionHandoffResolution;
}): Promise<AgentOrgTaskExecutionHandoffReceipt> {
  const result = await invokeTauri<AgentOrgTaskExecutionHandoffReceipt>(
    "agent_org_task_handoff_resolve",
    { request: input }
  );
  publishAgentOrgStateChange(input.sessionId);
  return result;
}

export async function getAgentOrgTaskPage(input: {
  sessionId: string;
  bucket: AgentOrgTaskPageBucket;
  status?: AgentOrgTaskStatus | null;
  cursor?: string | null;
  direction?: AgentOrgTaskPageDirection;
  limit?: number;
}): Promise<AgentOrgTaskPage> {
  return invokeTauri<AgentOrgTaskPage>("agent_org_session_task_page", {
    sessionId: input.sessionId,
    bucket: input.bucket,
    status: input.status ?? null,
    cursor: input.cursor ?? null,
    direction: input.direction ?? "forward",
    limit: input.limit ?? 50,
  });
}

export async function getAgentOrgTaskDetail(input: {
  sessionId: string;
  taskId: string;
}): Promise<AgentOrgTask> {
  return invokeTauri<AgentOrgTask>("agent_org_session_task_detail", input);
}

export async function getAgentOrgTaskAnnotationPage(input: {
  sessionId: string;
  taskId: string;
  cursor?: string | null;
  limit?: number;
}): Promise<AgentOrgTaskAnnotationPage> {
  return invokeTauri<AgentOrgTaskAnnotationPage>(
    "agent_org_session_task_annotation_page",
    {
      sessionId: input.sessionId,
      taskId: input.taskId,
      cursor: input.cursor ?? null,
      limit: input.limit ?? 50,
    }
  );
}

export async function getAgentOrgGroupChatHistoryPage(input: {
  sessionId: string;
  beforeId?: number | null;
  limit?: number;
}): Promise<AgentOrgGroupChatHistoryPage> {
  return invokeTauri<AgentOrgGroupChatHistoryPage>(
    "agent_org_group_chat_history_page",
    {
      sessionId: input.sessionId,
      beforeId: input.beforeId ?? null,
      limit: input.limit ?? 100,
    }
  );
}

export async function getAgentOrgPlanApprovalDetail(input: {
  sessionId: string;
  approvalId: string;
  planRevisionId: string;
}): Promise<AgentOrgPlanApproval> {
  return invokeTauri<AgentOrgPlanApproval>(
    "agent_org_plan_approval_detail",
    input
  );
}

export async function respondAgentOrgPlanApproval(input: {
  sessionId: string;
  approvalId: string;
  planRevisionId: string;
  sourceTaskId: string;
  sourceTurnIntentId: string;
  decision: "approve" | "request_changes";
  feedback?: string | null;
}): Promise<AgentOrgPlanApproval> {
  return invokeTauri<AgentOrgPlanApproval>("agent_org_plan_approval_respond", {
    ...input,
    feedback: input.feedback ?? null,
  });
}

export async function retryAgentOrgFinalSummary(input: {
  sessionId: string;
  certificateId: string;
  failedAttempt: number;
  requestId?: string;
}): Promise<AgentOrgFinalSummaryReceipt> {
  const receipt = await invokeTauri<AgentOrgFinalSummaryReceipt>(
    "agent_org_final_summary_retry",
    {
      ...input,
      requestId: input.requestId ?? crypto.randomUUID(),
    }
  );
  publishAgentOrgStateChange(input.sessionId);
  return receipt;
}

export async function returnAgentOrgSessionToWork(
  sessionId: string,
  interventionReceiptId: string,
  requestId: string
): Promise<ReturnToWorkResult> {
  const result = await invokeTauri<ReturnToWorkResult>(
    "agent_org_session_return_to_work",
    {
      sessionId,
      interventionReceiptId,
      requestId,
    }
  );
  publishAgentOrgStateChange(sessionId);
  return result;
}

export async function sendAgentOrgGroupChatMessage(
  sessionId: string,
  deliveries: AgentOrgGroupDeliveryInput[],
  content: string,
  displayText?: string,
  images?: string[]
): Promise<AgentOrgGroupChatMessageResponse> {
  const response = await invokeTauri<AgentOrgGroupChatMessageResponse>(
    "agent_org_send_group_chat_message",
    {
      sessionId,
      deliveries,
      content,
      displayText: displayText ?? null,
      images: images?.length ? images : null,
    }
  );
  publishAgentOrgStateChange(sessionId);
  return response;
}

export async function pauseAgentOrgRun(
  sessionId: string,
  requestId: string = crypto.randomUUID()
): Promise<PauseRunOutcome> {
  const outcome = await invokeTauri<PauseRunOutcome>("agent_org_pause_run", {
    sessionId,
    requestId,
  });
  publishAgentOrgStateChange(sessionId);
  return outcome;
}

export async function resumeAgentOrgRun(
  sessionId: string,
  requestId: string = crypto.randomUUID()
): Promise<ResumeRunOutcome> {
  const outcome = await invokeTauri<ResumeRunOutcome>("agent_org_resume_run", {
    sessionId,
    requestId,
  });
  publishAgentOrgStateChange(sessionId);
  return outcome;
}

export async function archiveAgentOrgRun(
  sessionId: string,
  requestId: string = crypto.randomUUID()
): Promise<ArchiveRunOutcome> {
  const outcome = await invokeTauri<ArchiveRunOutcome>(
    "agent_org_archive_run",
    { sessionId, requestId }
  );
  publishAgentOrgStateChange(sessionId);
  return outcome;
}

export async function deleteAgentOrgTeam(
  sessionId: string
): Promise<DeleteSessionReceipt> {
  return invokeTauri<DeleteSessionReceipt>("agent_org_delete_team", {
    sessionId,
  });
}
