import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { makeSessionEvent } from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

import TerminalActivityGroup, { buildGroupSummary } from ".";

vi.mock("@src/engines/ChatPanel/hooks/useChatEventReplay", () => ({
  useChatEventReplay: () => ({
    replayEventById: vi.fn(),
    canReplay: false,
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

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

  it("keeps a created Work Item card visible when the command stack is collapsed", () => {
    const stdout = JSON.stringify({
      apiVersion: "orgtrack/v1",
      ok: true,
      data: {
        body: "",
        filename: "WI-0100",
        frontmatter: {
          id: "WI-0100",
          short_id: "WI-0100",
          title: "Visible create result",
          status: "backlog",
          priority: "none",
          labels: [],
          todos: [],
          starred: false,
          created_at: "2026-08-09T00:00:00Z",
          updated_at: "2026-08-09T00:00:00Z",
        },
      },
    });
    const baseEvent = makeSessionEvent({
      action_type: "tool_call",
      function: "run_shell",
      uiCanonical: "run_shell",
      args: {
        command:
          "org2-pm work create --standalone --title 'Visible create result'",
      },
      result: { shellReplayBacked: true },
      shellExitCode: 0,
    });
    const event = {
      ...baseEvent,
      shellReplay: {
        ref: {
          sessionId: baseEvent.sessionId,
          callId: "call-create-work-item",
          formatVersion: 1,
        },
        bookmark: { visibleThroughSequence: 1, visibleBytes: stdout.length },
        terminalPreview: stdout,
        status: "complete" as const,
      },
    };

    const markup = renderToStaticMarkup(
      createElement(TerminalActivityGroup, {
        events: [event],
        closedByBoundary: true,
      })
    );

    expect(markup).toContain('data-testid="work-item-result-card"');
    expect(markup).toContain('data-work-item-id="WI-0100"');
    expect(markup).toContain("Visible create result");
  });

  it("keeps a host-bootstrapped Work Item update visible outside the command stack", () => {
    const stdout = JSON.stringify({
      apiVersion: "orgtrack/v1",
      ok: true,
      data: {
        body: "Create a root item",
        filename: "WI-0101",
        frontmatter: {
          id: "WI-0101",
          short_id: "WI-0101",
          title: "Updated bootstrap root",
          status: "backlog",
          priority: "none",
          labels: [],
          todos: [],
          starred: false,
          created_at: "2026-08-09T00:00:00Z",
          updated_at: "2026-08-09T00:01:00Z",
        },
      },
    });
    const baseEvent = makeSessionEvent({
      action_type: "tool_call",
      function: "run_shell",
      uiCanonical: "run_shell",
      args: {
        command:
          "org2-pm work update WI-0101 --standalone --title 'Updated bootstrap root'",
      },
      result: { shellReplayBacked: true },
      shellExitCode: 0,
    });
    const event = {
      ...baseEvent,
      shellReplay: {
        ref: {
          sessionId: baseEvent.sessionId,
          callId: "call-update-bootstrap-root",
          formatVersion: 1,
        },
        bookmark: { visibleThroughSequence: 1, visibleBytes: stdout.length },
        terminalPreview: stdout,
        status: "complete" as const,
      },
    };

    const markup = renderToStaticMarkup(
      createElement(TerminalActivityGroup, {
        events: [event],
        closedByBoundary: true,
      })
    );

    expect(markup).toContain('data-testid="work-item-result-card"');
    expect(markup).toContain('data-work-item-id="WI-0101"');
    expect(markup).toContain("Updated bootstrap root");
  });
});
