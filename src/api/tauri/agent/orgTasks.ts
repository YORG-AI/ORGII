import { invokeTauri } from "@src/util/platform/tauri/init";

export const AGENT_ORG_USER_SENDER_ID = "_user" as const;

export const AGENT_ORG_TASK_STATUS = {
  PENDING: "pending",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
} as const;

export type AgentOrgTaskStatus =
  (typeof AGENT_ORG_TASK_STATUS)[keyof typeof AGENT_ORG_TASK_STATUS];

export interface AgentOrgMemberIntervention {
  orgRunId: string;
  memberId: string;
  agentId: string;
  sessionId: string;
  status: "user_intervention";
  reason?: string | null;
  enteredAt: string;
  lastUserActivityAt: string;
  resumeAfter: string;
  clearedAt?: string | null;
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
  parentMemberId?: string | null;
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
  hierarchyMode: string;
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
  parentMemberId?: string | null;
  isCoordinator: boolean;
  sessionRuntime?: AgentOrgOwnerRuntime | null;
  unreadInboxCount: number;
  inboxActivityCount: number;
  activeTaskCount: number;
  pendingTaskCount: number;
  inProgressTaskCount: number;
  completedTaskCount: number;
  intervention?: AgentOrgMemberIntervention | null;
}

export const AGENT_ORG_RUN_STATUS = {
  RUNNING: "running",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  ABANDONED: "abandoned",
} as const;

export type AgentOrgRunStatus =
  (typeof AGENT_ORG_RUN_STATUS)[keyof typeof AGENT_ORG_RUN_STATUS];

export const AGENT_ORG_RUN_PHASE = {
  COORDINATING: "coordinating",
  DISPATCHING: "dispatching",
  MEMBERS_WORKING: "members_working",
  WAITING: "waiting",
  AWAITING_PLAN_APPROVAL: "awaiting_plan_approval",
  FINALIZING: "finalizing",
  PAUSED: "paused",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
  ABANDONED: "abandoned",
} as const;

export type AgentOrgRunPhase =
  (typeof AGENT_ORG_RUN_PHASE)[keyof typeof AGENT_ORG_RUN_PHASE];

export interface AgentOrgRunView {
  context: AgentOrgRunContext;
  runStatus: AgentOrgRunStatus;
  runPhase: AgentOrgRunPhase;
  currentMemberId?: string | null;
  members: AgentOrgRunMemberView[];
  tasks: AgentOrgTask[];
  taskOverview: AgentOrgRunTaskOverview;
  inbox: AgentOrgInboxPreviewRow[];
  unreadInboxCount: number;
  pendingPlanApprovals: AgentOrgPlanApprovalSummary[];
}

export interface AgentOrgRunTaskOverview {
  total: number;
  pending: number;
  inProgress: number;
  completed: number;
  corrupt: number;
  visible: number;
  truncated: boolean;
}

export interface AgentOrgPlanApprovalSummary {
  approvalId: string;
  planRevisionId: string;
  requestId: string;
  orgRunId: string;
  sourceTaskId: string;
  sourceMemberId: string;
  sourceSessionId: string;
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
  createdAt: string;
}

export interface AgentOrgPlanApproval {
  approvalId: string;
  planRevisionId: string;
  requestId: string;
  orgRunId: string;
  sourceTaskId: string;
  sourceMemberId: string;
  sourceSessionId: string;
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
  decisionBy?: string | null;
  feedback?: string | null;
  createdAt: string;
  resolvedAt?: string | null;
}

export interface AgentOrgDirectMemberMessageResponse {
  memberSessionId: string;
  response: {
    content: string;
    sessionId: string;
    model: string;
  };
}

export interface AgentOrgGroupChatMessageResponse {
  targetMemberId: string;
  targetMemberName: string;
  inboxRow: AgentOrgInboxRuntimeRow;
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
  status: AgentOrgTaskStatus;
  blocks: string[];
  /** True when the polling/list projection carries only a prefix. */
  blocksTruncated?: boolean;
  blockedBy: string[];
  /** True when the polling/list projection carries only a prefix. */
  blockedByTruncated?: boolean;
  metadata?: unknown;
  executionMode: "build" | "plan";
  createdAt: string;
  updatedAt: string;
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
  decision: "approve" | "approve_with_edits" | "request_changes";
  editedContent?: string | null;
  feedback?: string | null;
}): Promise<AgentOrgPlanApproval> {
  return invokeTauri<AgentOrgPlanApproval>("agent_org_plan_approval_respond", {
    ...input,
    editedContent: input.editedContent ?? null,
    feedback: input.feedback ?? null,
  });
}

export async function enterAgentOrgSessionIntervention(
  sessionId: string
): Promise<boolean> {
  const changed = await invokeTauri<boolean>(
    "agent_org_session_enter_intervention",
    {
      sessionId,
    }
  );
  if (changed) publishAgentOrgStateChange(sessionId);
  return changed;
}

export async function returnAgentOrgSessionToWork(
  sessionId: string
): Promise<boolean> {
  const changed = await invokeTauri<boolean>(
    "agent_org_session_return_to_work",
    {
      sessionId,
    }
  );
  if (changed) publishAgentOrgStateChange(sessionId);
  return changed;
}

export async function sendAgentOrgGroupChatMessage(
  sessionId: string,
  targetMemberId: string | null,
  content: string,
  displayText?: string
): Promise<AgentOrgGroupChatMessageResponse> {
  const response = await invokeTauri<AgentOrgGroupChatMessageResponse>(
    "agent_org_send_group_chat_message",
    {
      sessionId,
      targetMemberId,
      content,
      displayText: displayText ?? null,
    }
  );
  publishAgentOrgStateChange(sessionId);
  return response;
}

export async function sendAgentOrgUserMessageToMember(
  sessionId: string,
  memberId: string,
  content: string
): Promise<AgentOrgDirectMemberMessageResponse> {
  const response = await invokeTauri<AgentOrgDirectMemberMessageResponse>(
    "agent_org_send_user_message_to_member",
    {
      sessionId,
      memberId,
      content,
    }
  );
  publishAgentOrgStateChange(sessionId);
  return response;
}

export async function pauseAgentOrgRun(sessionId: string): Promise<boolean> {
  const changed = await invokeTauri<boolean>("agent_org_pause_run", {
    sessionId,
  });
  if (changed) publishAgentOrgStateChange(sessionId);
  return changed;
}

export async function resumeAgentOrgRun(sessionId: string): Promise<boolean> {
  const changed = await invokeTauri<boolean>("agent_org_resume_run", {
    sessionId,
  });
  if (changed) publishAgentOrgStateChange(sessionId);
  return changed;
}
