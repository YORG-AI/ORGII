import { describe, expect, it } from "vitest";

import { resolveKanbanAgentIconId } from "./kanbanAgentBranding";

describe("resolveKanbanAgentIconId", () => {
  it("uses the ORG2 mark for ORGII-owned Rust definitions", () => {
    expect(resolveKanbanAgentIconId("builtin:sde", "code")).toBe("orgii");
    expect(resolveKanbanAgentIconId("builtin:agent-architect", "omega")).toBe(
      "orgii"
    );
  });

  it("preserves custom Rust-agent icons", () => {
    expect(resolveKanbanAgentIconId("custom-agent-1", "brain")).toBe("brain");
    expect(resolveKanbanAgentIconId(undefined, "network")).toBe("network");
  });
});
