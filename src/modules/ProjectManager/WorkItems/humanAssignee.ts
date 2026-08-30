export interface HumanAssigneeWrite {
  assignee?: string;
  assigneeType?: "human";
}

/**
 * Canonicalize assignment writes from UI drafts.
 *
 * A Work Item may still carry an agent execution target in its orchestrator
 * config, but the assignee field is reserved for a human roster identity.
 * `member` is accepted as the legacy human spelling and normalized on write.
 */
export function resolveHumanAssigneeWrite(
  assigneeId: string | undefined,
  assigneeType: string | undefined
): HumanAssigneeWrite {
  const normalizedId = assigneeId?.trim();
  const isHuman = assigneeType === "human" || assigneeType === "member";
  if (!normalizedId || !isHuman) return {};
  return { assignee: normalizedId, assigneeType: "human" };
}
