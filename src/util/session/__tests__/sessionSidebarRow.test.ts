import { FlaskConical } from "lucide-react";
import { describe, expect, it } from "vitest";

import { resolveAgentIcon } from "@src/config/agentIcons";
import { resolveSessionRowIcon } from "@src/util/session/sessionSidebarRow";

describe("resolveSessionRowIcon", () => {
  it("uses the OpenCode CLI brand icon", () => {
    expect(
      resolveSessionRowIcon({
        session_id: "cliagent-opencode",
        cliAgentType: "opencode",
      })
    ).toBe(resolveAgentIcon("opencode"));
  });

  it("uses cliAgentType before stale agentIconId for CLI sessions", () => {
    expect(
      resolveSessionRowIcon({
        session_id: "cliagent-opencode",
        cliAgentType: "opencode",
        agentIconId: "codex",
      })
    ).toBe(resolveAgentIcon("opencode"));
  });

  it("uses agentIconId for non-CLI agent sessions", () => {
    expect(
      resolveSessionRowIcon({
        session_id: "sdeagent-custom",
        agentIconId: "network",
      })
    ).toBe(resolveAgentIcon("network"));
  });

  it("keeps benchmark coordinator sessions on the benchmark icon", () => {
    expect(
      resolveSessionRowIcon({
        session_id: "cliagent-benchmark",
        user_input: "Benchmark run coordinator for OpenCode",
        cliAgentType: "opencode",
        agentIconId: "codex",
      })
    ).toBe(FlaskConical);
  });
});
