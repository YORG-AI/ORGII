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
  inbox: AgentOrgInboxRow[];
  pendingPlanApprovals: AgentOrgPlanApproval[];
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

export interface AgentOrgSessionInterventionState {
  intervention?: AgentOrgMemberIntervention | null;
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
  inboxRow: AgentOrgInboxRow;
}

export interface AgentOrgTask {
  id: string;
  orgRunId: string;
  subject: string;
  description: string;
  activeForm?: string | null;
  owner?: string | null;
  ownerMember?: AgentOrgRunContextMember | null;
  ownerRuntime?: AgentOrgOwnerRuntime | null;
  status: AgentOrgTaskStatus;
  blocks: string[];
  blockedBy: string[];
  metadata?: unknown;
  executionMode?: "build" | "plan";
  createdAt: string;
  updatedAt: string;
}

export interface AgentOrgInboxRow {
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
  payloadJson: string;
  requestId?: string | null;
  createdAt: string;
  readAt?: string | null;
}

export async function getAgentOrgSessionRunView(
  sessionId: string
): Promise<AgentOrgRunView | null> {
  return invokeTauri<AgentOrgRunView | null>("agent_org_session_run_view", {
    sessionId,
  });
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
  return invokeTauri<boolean>("agent_org_session_enter_intervention", {
    sessionId,
  });
}

export async function getAgentOrgSessionInterventionState(
  sessionId: string
): Promise<AgentOrgSessionInterventionState> {
  return invokeTauri<AgentOrgSessionInterventionState>(
    "agent_org_session_intervention_state",
    { sessionId }
  );
}

export async function returnAgentOrgSessionToWork(
  sessionId: string
): Promise<boolean> {
  return invokeTauri<boolean>("agent_org_session_return_to_work", {
    sessionId,
  });
}

export async function sendAgentOrgGroupChatMessage(
  sessionId: string,
  targetMemberId: string | null,
  content: string
): Promise<AgentOrgGroupChatMessageResponse> {
  return invokeTauri<AgentOrgGroupChatMessageResponse>(
    "agent_org_send_group_chat_message",
    {
      sessionId,
      targetMemberId,
      content,
    }
  );
}

export async function sendAgentOrgUserMessageToMember(
  sessionId: string,
  memberId: string,
  content: string
): Promise<AgentOrgDirectMemberMessageResponse> {
  return invokeTauri<AgentOrgDirectMemberMessageResponse>(
    "agent_org_send_user_message_to_member",
    {
      sessionId,
      memberId,
      content,
    }
  );
}

export async function pauseAgentOrgRun(sessionId: string): Promise<boolean> {
  return invokeTauri<boolean>("agent_org_pause_run", { sessionId });
}

export async function resumeAgentOrgRun(sessionId: string): Promise<boolean> {
  return invokeTauri<boolean>("agent_org_resume_run", { sessionId });
}
