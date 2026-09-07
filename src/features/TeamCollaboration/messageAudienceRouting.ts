/**
 * Canonical message-audience policy for collaboration composers.
 *
 * Identity parsing stays at each surface boundary (Team Chat resolves @labels
 * against the cloud roster; Work Items decode typed mention refs). Once targets
 * are identity-stable, this function is the only frontend owner of the policy:
 * Team Chat is always human conversation, while a Work Item comment defaults to
 * its assigned Agent unless an explicit human audience replaces that default.
 * Cross-surface precedence and defaults live in the adjacent policy JSON so
 * the Rust Work Item evaluator and this frontend evaluator cannot drift.
 */
import policyData from "./messageAudienceRouting.policy.json";

export type MessageAudienceSurface = "team_chat" | "work_item_comment";

export type MessageAudienceTarget =
  | { kind: "member"; id: string }
  | { kind: "agent"; id: string }
  | { kind: "agent_org"; id: string }
  | { kind: "all" };

export type HumanAudience =
  | { scope: "none"; memberIds: [] }
  | { scope: "channel"; memberIds: string[] }
  | { scope: "members"; memberIds: string[] };

export type AgentAudience =
  | { mode: "none" }
  | { mode: "assigned" }
  | {
      mode: "explicit";
      target: Extract<MessageAudienceTarget, { kind: "agent" | "agent_org" }>;
    };

export interface MessageAudienceRoute {
  human: HumanAudience;
  agent: AgentAudience;
}

type HumanScope = HumanAudience["scope"];
type NonExplicitAgentMode = Exclude<AgentAudience["mode"], "explicit">;

interface MessageAudienceSurfacePolicy {
  defaultHumanScope: HumanScope;
  memberHumanScope: HumanScope;
  allHumanScope: HumanScope;
  defaultAgentMode: NonExplicitAgentMode;
  humanAgentMode: NonExplicitAgentMode;
  explicitAgentMode: "none" | "explicit";
  explicitAgentWins: boolean;
}

const policies = policyData as Record<
  MessageAudienceSurface,
  MessageAudienceSurfacePolicy
>;

function uniqueMemberIds(targets: readonly MessageAudienceTarget[]): string[] {
  const seen = new Set<string>();
  const memberIds: string[] = [];
  for (const target of targets) {
    if (target.kind !== "member") continue;
    const id = target.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    memberIds.push(id);
  }
  return memberIds;
}

export function resolveMessageAudience(
  surface: MessageAudienceSurface,
  targets: readonly MessageAudienceTarget[]
): MessageAudienceRoute {
  const policy = policies[surface];
  const memberIds = uniqueMemberIds(targets);
  const addressesChannel = targets.some((target) => target.kind === "all");
  const explicitAgent = targets.find(
    (
      target
    ): target is Extract<
      MessageAudienceTarget,
      { kind: "agent" | "agent_org" }
    > => target.kind === "agent" || target.kind === "agent_org"
  );
  const humanScope = addressesChannel
    ? policy.allHumanScope
    : memberIds.length > 0
      ? policy.memberHumanScope
      : policy.defaultHumanScope;
  const human: HumanAudience =
    humanScope === "none"
      ? { scope: "none", memberIds: [] }
      : { scope: humanScope, memberIds };

  if (explicitAgent && policy.explicitAgentWins) {
    return {
      human,
      agent:
        policy.explicitAgentMode === "explicit"
          ? { mode: "explicit", target: explicitAgent }
          : { mode: "none" },
    };
  }

  return {
    human,
    agent: {
      mode:
        addressesChannel || memberIds.length > 0
          ? policy.humanAgentMode
          : policy.defaultAgentMode,
    },
  };
}
