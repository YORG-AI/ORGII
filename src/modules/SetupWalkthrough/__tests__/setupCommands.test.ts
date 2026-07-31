import { describe, expect, it, vi } from "vitest";

import { detectSetupTools, sanitizeDetectedTool } from "../setupCommands";

describe("setup commands", () => {
  it("drops every secret-bearing field from detected credentials", () => {
    const summary = sanitizeDetectedTool("codex", {
      success: true,
      agent_type: "codex",
      message: "found",
      keys: [
        {
          id: "key-1",
          name: "Codex",
          auth_method: "oauth",
          api_key: "must-not-survive",
          session_token: "must-not-survive",
          env_vars: { OPENAI_API_KEY: "must-not-survive" },
          validated: true,
        },
      ],
    });
    expect(summary).toEqual({
      agentType: "codex",
      found: true,
      keyCount: 1,
      validatedCount: 1,
    });
    expect(JSON.stringify(summary)).not.toContain("must-not-survive");
  });

  it("isolates a provider detection failure without failing the scan", async () => {
    const detect = vi.fn(async (agentType: string) => {
      if (agentType === "claude_code") throw new Error("unavailable");
      return {
        success: true,
        agent_type: agentType,
        message: "ok",
        keys: [],
      };
    });
    const results = await detectSetupTools(detect);
    expect(results).toHaveLength(3);
    expect(
      results.find((result) => result.agentType === "claude_code")
    ).toEqual({
      agentType: "claude_code",
      found: false,
      keyCount: 0,
      validatedCount: 0,
    });
  });
});
