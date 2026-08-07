import { FlaskConical } from "lucide-react";
import { describe, expect, it } from "vitest";

import {
  getIconProvider,
  getIconProviderFromType,
} from "@src/components/ModelIcon/config";
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

  it("uses the canonical Grok brand icon for Grok CLI", () => {
    expect(getIconProvider("grok_cli")).toBe("grok");
    expect(getIconProviderFromType("grok")).toBe("grok");
    expect(resolveAgentIcon("grok_cli")).toBe(resolveAgentIcon("grok"));
    expect(
      resolveSessionRowIcon({
        session_id: "cliagent-grok",
        cliAgentType: "grok_cli",
      })
    ).toBe(resolveAgentIcon("grok"));
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

  it("uses the canonical WorkBuddy brand icon for imported WorkBuddy sessions", () => {
    expect(resolveSessionRowIcon("workbuddyapp-example")).toBe(
      resolveAgentIcon("workbuddy")
    );
  });

  it.each([
    ["Claude Code root", "claudecodeapp-root", "claude_code"],
    ["Claude Code subagent", "claudecodeapp-agent-child", "claude_code"],
    ["Codex", "codexapp-thread", "codex"],
    ["Cursor", "cursoride-composer", "cursor"],
  ])("uses the sidebar brand icon for %s history", (_label, id, iconId) => {
    expect(resolveSessionRowIcon(id)).toBe(resolveAgentIcon(iconId));
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
