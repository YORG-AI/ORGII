import { describe, expect, it } from "vitest";

import {
  getIconProvider,
  getIconProviderFromType,
} from "@src/components/ModelIcon/config";
import { resolveAgentIcon } from "@src/config/agentIcons";
import {
  resolveSessionRowIcon,
  resolveSessionRowIconPresentation,
} from "@src/util/session/sessionSidebarRow";

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

  it("uses the Agent Org icon instead of the coordinator agent icon", () => {
    expect(
      resolveSessionRowIcon({
        session_id: "cliagent-org-coordinator",
        agentOrgId: "org-2",
        cliAgentType: "opencode",
        agentIconId: "code",
      })
    ).toBe(resolveAgentIcon("network"));
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

  it("uses imported app metadata when a cloud copy has no branded session id", () => {
    expect(
      resolveSessionRowIcon({
        session_id: "collab-import-1",
        importedFrom: { externalHistorySource: "codex_app" },
        agentIconId: "archive",
      })
    ).toBe(resolveAgentIcon("codex"));
  });

  it("uses the sidebar ORGII icon for imported native org sessions", () => {
    expect(
      resolveSessionRowIcon({
        session_id: "collab-import-1",
        importedFrom: {},
        agentIconId: "archive",
      })
    ).toBe(resolveAgentIcon("orgii"));
  });

  it("uses the ORGII icon before an imported session row has hydrated", () => {
    expect(resolveSessionRowIcon("imported-session-pending")).toBe(
      resolveAgentIcon("orgii")
    );
  });

  it("identifies current-color provider marks as monochrome brand icons", () => {
    expect(
      resolveSessionRowIconPresentation("codexapp-thread").isMonochromeBrandIcon
    ).toBe(true);
    expect(
      resolveSessionRowIconPresentation("cursoride-composer")
        .isMonochromeBrandIcon
    ).toBe(true);
    expect(
      resolveSessionRowIconPresentation({
        session_id: "sdeagent-custom",
        agentIconId: "network",
      }).isMonochromeBrandIcon
    ).toBe(false);
  });
});
