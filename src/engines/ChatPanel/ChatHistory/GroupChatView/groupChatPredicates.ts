import type { SessionEvent } from "@src/engines/SessionCore/core/types";

const USER_TURN_FUNCTION_NAMES = new Set([
  "user_message",
  "user",
  "user_input",
  "raw_event",
  "raw",
]);

const COORDINATOR_AGENT_MESSAGE_FUNCTION_NAMES = new Set([
  "org_send_message",
  "send_message",
  "send_to_inbox",
]);

export function isAgentOrgInboxTranscriptEvent(event: SessionEvent): boolean {
  return Boolean(
    event.args?.agentOrgInboxTranscript === true ||
    event.result?.agentOrgInboxTranscript === true
  );
}

export function isAgentOrgGroupChatUserMessage(event: SessionEvent): boolean {
  return Boolean(
    event.args?.agentOrgGroupChatMessage === true ||
    event.result?.agentOrgGroupChatMessage === true
  );
}

export function isCoordinatorHumanUserEvent(
  event: SessionEvent,
  coordinatorSessionId: string
): boolean {
  if (event.sessionId !== coordinatorSessionId) return false;
  if (event.source !== "user") return false;
  if (!event.displayText.trim()) return false;
  if (isAgentOrgInboxTranscriptEvent(event)) return false;
  if (isAgentOrgGroupChatUserMessage(event)) return true;

  const functionName = event.functionName.toLowerCase();
  if (COORDINATOR_AGENT_MESSAGE_FUNCTION_NAMES.has(functionName)) return false;
  if (USER_TURN_FUNCTION_NAMES.has(functionName)) return true;
  if (functionName.includes("user_response")) return true;
  if (functionName.includes("user_input")) return true;

  const result = event.result as Record<string, unknown> | undefined;
  const resultMessage = result?.message as { role?: string } | undefined;
  return result?.type === "user" || resultMessage?.role === "user";
}
