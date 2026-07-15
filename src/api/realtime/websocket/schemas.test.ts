import { describe, expect, it } from "vitest";

import { maybeParseCodeEditorWebSocketMessage } from "./schemas";

describe("Hermes terminal status WebSocket schema", () => {
  it("accepts the blocked lifecycle event with privacy-safe activity", () => {
    const message = maybeParseCodeEditorWebSocketMessage(
      JSON.stringify({
        type: "terminal_agent.status_changed",
        terminal_session_id: "chatpanel-hermes",
        cli_agent_type: "hermes",
        agent_status: "blocked",
        hook_event_name: "pre_approval_request",
        tool_name: "terminal",
        tool_input_preview: "pnpm test",
        cwd: "/workspace/orgii",
        timestamp: 1,
      })
    );

    expect(message).toMatchObject({
      type: "terminal_agent.status_changed",
      terminal_session_id: "chatpanel-hermes",
      agent_status: "blocked",
      tool_name: "terminal",
      tool_input_preview: "pnpm test",
    });
  });

  it("rejects an invalid lifecycle status", () => {
    expect(() =>
      maybeParseCodeEditorWebSocketMessage(
        JSON.stringify({
          type: "terminal_agent.status_changed",
          terminal_session_id: "chatpanel-hermes",
          agent_status: "idle",
          timestamp: 1,
        })
      )
    ).toThrow();
  });
});
