import { describe, expect, it } from "vitest";

import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import {
  buildGroupChatSessionEvents,
  isAgentOrgInboxTranscriptEvent,
  isCoordinatorHumanUserEvent,
  isTaskRelatedGroupChatEvent,
  resolveGroupChatMessageBubble,
  resolveGroupChatToolUseSummary,
} from "../groupChatUtils";

const COORDINATOR_SESSION_ID = "coordinator-session";
const MEMBER_SESSION_ID = "member-session";

const PLANNER_MEMBER: AgentOrgRunMemberView = {
  memberId: "sde_planner",
  name: "SDE planner",
  role: "Planner",
  agentId: "builtin:sde",
  isCoordinator: false,
  sessionRuntime: {
    sessionId: MEMBER_SESSION_ID,
    status: "idle",
    updatedAt: "2026-05-29T00:00:00.000Z",
  },
  unreadInboxCount: 0,
  inboxActivityCount: 0,
  activeTaskCount: 0,
  pendingTaskCount: 0,
  inProgressTaskCount: 0,
  completedTaskCount: 0,
};

const ORG_MEMBERS: ReadonlyArray<AgentOrgRunMemberView> = [PLANNER_MEMBER];

function event(overrides: Partial<SessionEvent>): SessionEvent {
  const base: SessionEvent = {
    chunk_id: null,
    id: "event-id",
    sessionId: MEMBER_SESSION_ID,
    createdAt: "2026-05-29T00:00:00.000Z",
    functionName: "user_message",
    uiCanonical: "user_message",
    actionType: "raw",
    args: {},
    result: {},
    source: "assistant",
    displayText: "",
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "processed",
  };
  return {
    ...base,
    ...overrides,
    uiCanonical:
      overrides.uiCanonical ?? overrides.functionName ?? base.uiCanonical,
  };
}

function build(events: SessionEvent[]): SessionEvent[] {
  return buildGroupChatSessionEvents(
    new Map([
      [
        COORDINATOR_SESSION_ID,
        [
          event({
            id: "user-turn",
            sessionId: COORDINATOR_SESSION_ID,
            createdAt: "2026-05-29T00:00:00.000Z",
            functionName: "user_message",
            uiCanonical: "user_message",
            actionType: "raw",
            source: "user",
            displayText: "Start work",
            result: { type: "user", message: "Start work" },
          }),
        ],
      ],
      [MEMBER_SESSION_ID, events],
    ]),
    new Set([COORDINATOR_SESSION_ID, MEMBER_SESSION_ID]),
    COORDINATOR_SESSION_ID,
    ORG_MEMBERS
  );
}

describe("groupChatUtils", () => {
  it("does not treat coordinator inbox transcripts as pinned human prompts", () => {
    const transcript = event({
      id: "coordinator-inbox-transcript",
      sessionId: COORDINATOR_SESSION_ID,
      source: "user",
      args: { agentOrgInboxTranscript: true },
      displayText: "Reviewed messages from subagents.",
      result: { type: "user", message: "Reviewed messages from subagents." },
    });

    expect(
      isCoordinatorHumanUserEvent(transcript, COORDINATOR_SESSION_ID)
    ).toBe(false);

    const merged = buildGroupChatSessionEvents(
      new Map([
        [COORDINATOR_SESSION_ID, [transcript]],
        [MEMBER_SESSION_ID, []],
      ]),
      new Set([COORDINATOR_SESSION_ID, MEMBER_SESSION_ID]),
      COORDINATOR_SESSION_ID,
      ORG_MEMBERS
    );

    expect(merged.map((candidate) => candidate.id)).toEqual([
      "coordinator-inbox-transcript",
    ]);
  });

  it("renders synthetic user group chat messages as turn headers, not bubbles", () => {
    const userGroupMessage = event({
      id: "user-group-chat",
      sessionId: COORDINATOR_SESSION_ID,
      source: "user",
      functionName: "agent_org_group_chat_user_message",
      uiCanonical: "user_message",
      args: {
        recipientMemberId: "sde_planner",
        agentOrgGroupChatMessage: true,
      },
      displayText: "Please prioritize this question.",
      result: {
        type: "user",
        message: { role: "user", content: "Please prioritize this question." },
        agentOrgGroupChatMessage: true,
      },
    });

    expect(
      isCoordinatorHumanUserEvent(userGroupMessage, COORDINATOR_SESSION_ID)
    ).toBe(true);
    expect(
      resolveGroupChatMessageBubble(
        userGroupMessage,
        COORDINATOR_SESSION_ID,
        ORG_MEMBERS
      )
    ).toBeNull();
  });

  it("renders annotated member replies as addressed to the user", () => {
    const memberReply = event({
      id: "member-reply-user",
      sessionId: MEMBER_SESSION_ID,
      source: "assistant",
      functionName: "agent_message",
      uiCanonical: "agent_message",
      displayText: "I will handle your question first.",
      result: {
        type: "agent_message",
        message: "I will handle your question first.",
        agentOrgReplyRecipientName: "User",
      },
    });

    expect(
      resolveGroupChatMessageBubble(
        memberReply,
        COORDINATOR_SESSION_ID,
        ORG_MEMBERS
      )
    ).toMatchObject({
      senderName: "SDE planner",
      recipientName: "User",
      bodyMarkdown: "I will handle your question first.",
      kind: "agent_message",
    });
  });

  it("does not merge member random user prompts into the group feed", () => {
    const merged = build([
      event({
        id: "member-user-prompt",
        source: "user",
        displayText: "Execution mode requested: plan",
        result: { type: "user", message: "Execution mode requested: plan" },
      }),
    ]);

    expect(merged.map((candidate) => candidate.id)).toEqual(["user-turn"]);
  });

  it("keeps member inbox transcripts as renderable message records", () => {
    const transcript = event({
      id: "member-inbox-transcript",
      source: "user",
      args: { agentOrgInboxTranscript: true },
      displayText: "Read-only git history analysis complete.",
      result: {
        type: "user",
        message: "Read-only git history analysis complete.",
      },
    });

    const merged = build([transcript]);

    expect(isAgentOrgInboxTranscriptEvent(transcript)).toBe(true);
    expect(merged.map((candidate) => candidate.id)).toEqual([
      "user-turn",
      "member-inbox-transcript",
    ]);
  });

  it("keeps task assignment transcripts as message bubbles", () => {
    const merged = build([
      event({
        id: "task-assigned-transcript",
        source: "user",
        args: { agentOrgInboxTranscript: true },
        displayText: [
          "Task assigned by Coordinator: Analyze recent git commits",
          "Task ID: d2895c11-dacd-4ff3-8827-7b7e63a9f8da",
          "Inspect recent git history and summarize themes.",
        ].join("\n"),
        result: {
          type: "user",
          message: [
            "Task assigned by Coordinator: Analyze recent git commits",
            "Task ID: d2895c11-dacd-4ff3-8827-7b7e63a9f8da",
            "Inspect recent git history and summarize themes.",
          ].join("\n"),
        },
      }),
    ]);

    expect(merged.map((candidate) => candidate.id)).toEqual([
      "user-turn",
      "task-assigned-transcript",
    ]);
    expect(
      resolveGroupChatMessageBubble(
        merged[1],
        COORDINATOR_SESSION_ID,
        ORG_MEMBERS
      )
    ).toMatchObject({
      senderName: "Coordinator",
      recipientName: "SDE planner",
      kind: "task",
    });
    expect(resolveGroupChatToolUseSummary(merged[1])).toBeNull();
  });

  it("keeps task events visible instead of summarizing them", () => {
    const taskEvent = event({
      id: "task-update",
      functionName: "task_update",
      uiCanonical: "task_update",
      actionType: "tool_call",
      source: "assistant",
      displayText: "Updated task status",
      args: { task_id: "task-1", status: "done" },
      result: { ok: true },
    });

    const merged = build([
      event({
        id: "agent-message",
        functionName: "agent_message",
        uiCanonical: "agent_message",
        actionType: "assistant",
        source: "assistant",
        displayText: "I reviewed the messages.",
        result: { message: "I reviewed the messages." },
      }),
      taskEvent,
    ]);

    expect(isTaskRelatedGroupChatEvent(taskEvent)).toBe(true);
    expect(
      isTaskRelatedGroupChatEvent(
        event({ id: "task-graph", functionName: "task_graph_create" })
      )
    ).toBe(true);
    expect(merged.map((candidate) => candidate.id)).toEqual([
      "user-turn",
      "agent-message",
      "task-update",
    ]);
    expect(resolveGroupChatToolUseSummary(merged[1])).toBeNull();
  });

  it("attaches non-task tool summaries to the last message in a same-agent sequence", () => {
    const merged = build([
      event({
        id: "first-message",
        functionName: "agent_message",
        uiCanonical: "agent_message",
        actionType: "assistant",
        source: "assistant",
        displayText: "First update.",
        result: { message: "First update." },
      }),
      event({
        id: "read-file",
        functionName: "read_file",
        uiCanonical: "read_file",
        actionType: "tool_call",
        source: "assistant",
        displayText: "Read file",
      }),
      event({
        id: "last-message",
        functionName: "agent_message",
        uiCanonical: "agent_message",
        actionType: "assistant",
        source: "assistant",
        displayText: "Last update.",
        result: { message: "Last update." },
      }),
      event({
        id: "run-shell",
        functionName: "run_shell",
        uiCanonical: "run_shell",
        actionType: "tool_call",
        source: "assistant",
        displayText: "Ran shell",
        args: { command: "git status" },
        result: { stdout: "clean" },
      }),
    ]);

    expect(merged.map((candidate) => candidate.id)).toEqual([
      "user-turn",
      "first-message",
      "last-message",
    ]);
    expect(resolveGroupChatToolUseSummary(merged[1])).toBeNull();
    expect(resolveGroupChatToolUseSummary(merged[2])).toEqual({
      readFiles: 1,
      editedFiles: 0,
      terminalUses: 1,
      explorations: 0,
      otherTools: 0,
    });
  });
});
