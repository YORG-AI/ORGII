import { describe, expect, it } from "vitest";

import { makeSessionEvent } from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

import { buildGroupSummary } from ".";

const translateSummary = (
  key: string,
  opts?: Record<string, unknown>
): string => {
  const count = Number(opts?.count ?? 0);
  if (key === "tools.terminalSummary.command") {
    return `${count} command${count === 1 ? "" : "s"}`;
  }
  if (key === "tools.terminalSummary.mcp") {
    return `${count} MCP call${count === 1 ? "" : "s"}`;
  }
  if (key === "tools.terminalSummary.separator") return ", ";
  return key;
};

describe("buildGroupSummary", () => {
  it("summarizes mixed shell and MCP activity with MCP calls after commands", () => {
    const events = [
      makeSessionEvent({
        action_type: "tool_call",
        function: "run_shell",
        args: { command: "git status" },
      }),
      makeSessionEvent({
        action_type: "tool_call",
        function: "mcp_node_repl_js",
      }),
      makeSessionEvent({
        action_type: "tool_call",
        function: "codex_app__read_thread_terminal",
      }),
      makeSessionEvent({
        action_type: "tool_call",
        function: "mcp__docs__search",
      }),
      makeSessionEvent({
        action_type: "tool_call",
        function: "search_docs",
        args: { server: "docs" },
      }),
      makeSessionEvent({
        action_type: "tool_call",
        function: "run_shell",
        args: { command: "git diff" },
      }),
    ];

    expect(buildGroupSummary(events, translateSummary)).toBe(
      "2 commands, 4 MCP calls"
    );
  });
});
