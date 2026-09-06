import { describe, expect, it } from "vitest";

import {
  type MessageAudienceSurface,
  type MessageAudienceTarget,
  resolveMessageAudience,
} from "./messageAudienceRouting";
import contractCases from "./messageAudienceRouting.contract.json";

interface AudienceContractCase {
  name: string;
  surface: MessageAudienceSurface;
  targets: MessageAudienceTarget[];
  expected: {
    humanScope: "none" | "channel" | "members";
    memberIds: string[];
    agentMode: "none" | "assigned" | "explicit";
  };
}

describe("resolveMessageAudience", () => {
  for (const contractCase of contractCases as AudienceContractCase[]) {
    it(contractCase.name, () => {
      const route = resolveMessageAudience(
        contractCase.surface,
        contractCase.targets
      );
      expect({
        humanScope: route.human.scope,
        memberIds: route.human.memberIds,
        agentMode: route.agent.mode,
      }).toEqual(contractCase.expected);
    });
  }
});
