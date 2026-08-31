import { describe, expect, it } from "vitest";

import type { SessionEvent } from "@src/engines/SessionCore/core/types";

import { isOrgTaskEvent } from "../AgentEventBubbles";

describe("isOrgTaskEvent", () => {
  it("routes task_graph_create through the Agent Org task renderer", () => {
    expect(
      isOrgTaskEvent({
        id: "task-graph",
        functionName: "task_graph_create",
      } as SessionEvent)
    ).toBe(true);
  });
});
