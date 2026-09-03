/**
 * useGroupChatFeed — helpers for the merged group chat feed.
 *
 * `buildAgentList` picks the contributing sessions; the merged event
 * array is supplied by the caller and injected into the
 * regular `ChatHistory` pipeline via `ChatHistoryOverrideContext`.
 */
import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";

import type { GroupChatAgent } from "./types";

const pendingMemberSessionId = (memberId: string) =>
  `agent-org-member-pending:${memberId}`;

/**
 * Build the ordered agent list for a run: coordinator first, then every
 * configured member. Historical/restarted Agent Team views often hydrate the
 * durable run roster before every member runtime is attached again; the group
 * chat must still open immediately instead of waiting on runtime session ids.
 */
export function buildAgentList(
  coordinatorSessionId: string,
  members: ReadonlyArray<AgentOrgRunMemberView>
): GroupChatAgent[] {
  const agents: GroupChatAgent[] = [];
  const coordinatorMember = members.find((member) => member.isCoordinator);
  agents.push({
    id: coordinatorMember?.memberId ?? "coordinator",
    name: "Coordinator",
    sessionId: coordinatorSessionId,
    member: coordinatorMember ?? null,
    isCoordinator: true,
  });
  for (const member of members) {
    if (member.isCoordinator) continue;
    agents.push({
      id: member.memberId,
      name: member.name,
      sessionId:
        member.sessionRuntime?.sessionId ??
        pendingMemberSessionId(member.memberId),
      member,
      isCoordinator: false,
    });
  }
  return agents;
}
