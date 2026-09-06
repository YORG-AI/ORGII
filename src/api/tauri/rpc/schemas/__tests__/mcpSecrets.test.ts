import { describe, expect, it } from "vitest";

import {
  MCP_SECRET_REDACTED_SENTINEL,
  McpConfigFileSchema,
  McpTestServerInput,
} from "../mcp";

describe("MCP write-only connection wire contract", () => {
  it("keeps a stable sentinel accepted by the config response schema", () => {
    expect(MCP_SECRET_REDACTED_SENTINEL).toBe("__ORGII_MCP_SECRET_REDACTED__");

    const parsed = McpConfigFileSchema.parse({
      mcpServers: {
        docs: {
          type: "streamableHttp",
          command: MCP_SECRET_REDACTED_SENTINEL,
          args: [MCP_SECRET_REDACTED_SENTINEL],
          cwd: MCP_SECRET_REDACTED_SENTINEL,
          url: MCP_SECRET_REDACTED_SENTINEL,
          env: { API_TOKEN: MCP_SECRET_REDACTED_SENTINEL },
          headers: { Authorization: MCP_SECRET_REDACTED_SENTINEL },
          disabled: false,
          timeout: 30,
        },
      },
    });

    expect(parsed.mcpServers.docs.command).toBe(MCP_SECRET_REDACTED_SENTINEL);
    expect(parsed.mcpServers.docs.args).toEqual([MCP_SECRET_REDACTED_SENTINEL]);
    expect(parsed.mcpServers.docs.cwd).toBe(MCP_SECRET_REDACTED_SENTINEL);
    expect(parsed.mcpServers.docs.url).toBe(MCP_SECRET_REDACTED_SENTINEL);
    expect(parsed.mcpServers.docs.env?.API_TOKEN).toBe(
      MCP_SECRET_REDACTED_SENTINEL
    );
    expect(parsed.mcpServers.docs.headers?.Authorization).toBe(
      MCP_SECRET_REDACTED_SENTINEL
    );
  });

  it("carries workspace and owning scope when testing an edited server", () => {
    expect(
      McpTestServerInput.parse({
        serverName: "docs",
        config: {
          type: "stdio",
          command: "docs-server",
          env: { API_TOKEN: MCP_SECRET_REDACTED_SENTINEL },
        },
        workspacePath: "/repo",
        scope: "workspace",
      })
    ).toMatchObject({
      serverName: "docs",
      workspacePath: "/repo",
      scope: "workspace",
    });
  });

  it("rejects an unknown scope instead of falling back to another owner", () => {
    expect(
      McpTestServerInput.safeParse({
        serverName: "docs",
        config: {},
        workspacePath: "/repo",
        scope: "workpace",
      }).success
    ).toBe(false);
  });
});
