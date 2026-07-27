import type { AgentOrgRunMemberView } from "@src/api/tauri/agent";

type AgentOrgMemberActivity = Pick<
  AgentOrgRunMemberView,
  | "activeTaskCount"
  | "pendingTaskCount"
  | "inProgressTaskCount"
  | "completedTaskCount"
  | "inboxActivityCount"
  | "unreadInboxCount"
>;

/**
 * Whether switching to a worker would open a genuinely empty session.
 *
 * `inboxActivityCount` is intentionally a bounded recent-history window,
 * while `unreadInboxCount` is the exact durable total. Both must be empty:
 * an old unread row can fall outside the recent window and is still real
 * work the user must be able to inspect.
 */
export function isAgentOrgMemberEmpty(member: AgentOrgMemberActivity): boolean {
  return (
    member.activeTaskCount === 0 &&
    member.pendingTaskCount === 0 &&
    member.inProgressTaskCount === 0 &&
    member.completedTaskCount === 0 &&
    member.inboxActivityCount === 0 &&
    member.unreadInboxCount === 0
  );
}
