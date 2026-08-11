/**
 * One internal rollout gate for the long-lived Agent Org redesign stack.
 * It is intentionally absent from Team settings and model/tool context.
 */
export const AGENT_ORG_REDESIGN_ENABLED =
  process.env.NODE_ENV === "test" ||
  process.env.ORGII_AGENT_ORG_REDESIGN === "1";

export function requireAgentOrgRedesign(): void {
  if (!AGENT_ORG_REDESIGN_ENABLED) {
    throw new Error(
      "agent_org_redesign_disabled: the long-lived Agent Team lifecycle is not enabled"
    );
  }
}
