import { describe, expect, it } from "vitest";

import { cliAgentCapabilityDisabled } from "./cliAgentCapability";

describe("cliAgentCapabilityDisabled", () => {
  it("leaves the complete New Session runtime list selectable", () => {
    for (const runtime of [
      "claude_code",
      "codex",
      "cursor_cli",
      "copilot",
      "kiro",
    ] as const) {
      expect(cliAgentCapabilityDisabled(runtime)).toBe(false);
    }
  });

  it("keeps installed runtimes visible while disabling lossy continuation targets", () => {
    const nativeTargets = ["claude_code", "codex", "cursor_cli"] as const;

    expect(cliAgentCapabilityDisabled("claude_code", nativeTargets)).toBe(
      false
    );
    expect(cliAgentCapabilityDisabled("codex", nativeTargets)).toBe(false);
    expect(cliAgentCapabilityDisabled("cursor_cli", nativeTargets)).toBe(false);
    expect(cliAgentCapabilityDisabled("copilot", nativeTargets)).toBe(true);
    expect(cliAgentCapabilityDisabled("kiro", nativeTargets)).toBe(true);
  });
});
