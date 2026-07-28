import { describe, expect, it } from "vitest";

import { isRustAgentTurnNeutralEvent } from "../createRustAgentAdapter";

describe("Rust agent event lifecycle classification", () => {
  it.each([
    "agent:snapshot_created",
    "agent:file_change",
    "agent:setup_repo_update",
    "agent:heartbeat",
    "agent:computer_use_aborted",
  ])("keeps asynchronous side-channel event %s turn-neutral", (eventType) => {
    expect(isRustAgentTurnNeutralEvent(eventType)).toBe(true);
  });

  it.each([
    "agent:message_delta",
    "agent:thinking_delta",
    "agent:tool_call",
    "agent:tool_result",
  ])("still treats substantive event %s as turn activity", (eventType) => {
    expect(isRustAgentTurnNeutralEvent(eventType)).toBe(false);
  });
});
