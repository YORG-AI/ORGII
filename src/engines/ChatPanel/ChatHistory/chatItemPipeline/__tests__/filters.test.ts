import { describe, expect, it } from "vitest";

import { makeSessionEvent } from "@src/engines/SessionCore/rendering/props/__tests__/fixtures";

import { willEventRenderContent } from "../filters";

describe("willEventRenderContent", () => {
  describe("raw_event handling", () => {
    it("returns false for raw_event with result.type=user but no body", () => {
      const event = makeSessionEvent({
        action_type: "raw_event",
        function: "",
        result: { type: "user" },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns true for raw_event with result.message", () => {
      const event = makeSessionEvent({
        action_type: "raw_event",
        function: "",
        result: {
          message: { role: "user", content: "hello" },
        },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns true for raw_event with user images", () => {
      const event = makeSessionEvent({
        action_type: "raw_event",
        function: "",
        result: {
          type: "user",
          images: ["data:image/png;base64,abc"],
        },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns false for raw_event without function and without result.type/message", () => {
      const event = makeSessionEvent({
        action_type: "raw_event",
        function: "",
        result: { some_field: "value" },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns true for raw_event with a function name", () => {
      const event = makeSessionEvent({
        action_type: "raw_event",
        function: "read_file",
        result: {},
      });
      expect(willEventRenderContent(event)).toBe(true);
    });
  });

  describe("assistant message handling", () => {
    it("returns false for assistant message display events without body", () => {
      const event = makeSessionEvent({
        action_type: "raw_event",
        function: "",
        source: "assistant",
        displayVariant: "message",
        result: {},
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns true for assistant message display events with body", () => {
      const event = makeSessionEvent({
        action_type: "raw_event",
        function: "",
        source: "assistant",
        displayVariant: "message",
        result: { content: "assistant reply" },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });
  });

  describe("thinking events", () => {
    it("returns false for empty thinking events", () => {
      const event = makeSessionEvent({
        action_type: "llm_thinking",
        function: "thinking",
        displayVariant: "thinking",
        result: {},
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns false for whitespace-only thinking events", () => {
      const event = makeSessionEvent({
        action_type: "llm_thinking",
        function: "thinking",
        displayVariant: "thinking",
        result: { thought: "  \n  ", content: "" },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns false for empty actionType-only thinking delta events", () => {
      const event = makeSessionEvent({
        action_type: "llm_thinking_delta",
        function: "",
        result: {},
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns false for empty thinking events even when source is assistant", () => {
      const event = makeSessionEvent({
        action_type: "llm_thinking_delta",
        function: "thinking",
        source: "assistant",
        displayVariant: "thinking",
        result: {},
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns false for whitespace-only assistant thinking events", () => {
      const event = makeSessionEvent({
        action_type: "llm_thinking_delta",
        function: "thinking",
        source: "assistant",
        displayText: "  \n  ",
        displayVariant: "thinking",
        result: { observation: "  \n  " },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns true for actionType-only thinking delta events with content", () => {
      const event = makeSessionEvent({
        action_type: "llm_thinking_delta",
        function: "",
        result: { observation: "I should inspect git history." },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns true for thinking events with thought content", () => {
      const event = makeSessionEvent({
        action_type: "llm_thinking",
        function: "thinking",
        displayVariant: "thinking",
        result: { thought: "I should inspect git history." },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });
  });

  describe("failed activities", () => {
    it("always returns true for failed status", () => {
      const event = makeSessionEvent({
        action_type: "tool_call",
        function: "read_file",
        status: "failed",
        result: {},
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns true for failed event even without result", () => {
      const event = makeSessionEvent({
        action_type: "tool_call",
        function: "edit_file",
        status: "failed",
        result: {},
      });
      expect(willEventRenderContent(event)).toBe(true);
    });
  });

  describe("run_shell", () => {
    it("returns true for running with command", () => {
      const event = makeSessionEvent({
        function: "run_shell",
        args: { command: "npm install" },
        result: { status: "running" },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns false for running without command (null result)", () => {
      const event = makeSessionEvent({
        function: "run_shell",
        args: {},
        result: null as unknown as Record<string, unknown>,
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns true for completed with stdout", () => {
      const event = makeSessionEvent({
        function: "run_shell",
        result: { status: "completed", stdout: "output text" },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns true for completed Claude Code CLI success payload with stdout", () => {
      const event = makeSessionEvent({
        function: "run_command_line",
        uiCanonical: "run_shell",
        result: {
          call_id: "toolu_123",
          success: { exitCode: 0, stderr: "", stdout: "org2ai.org2" },
        },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns true for completed Codex CLI shell payload with empty output but command", () => {
      const event = makeSessionEvent({
        function: "run_command_line",
        uiCanonical: "run_shell",
        args: {
          command: "node -e \"console.log(require('./package.json').name)\"",
        },
        result: {
          success: { exitCode: 0, stderr: "", stdout: "" },
        },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns false for completed without any output", () => {
      const event = makeSessionEvent({
        function: "run_shell",
        result: { status: "completed" },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns true for completed with stderr", () => {
      const event = makeSessionEvent({
        function: "run_shell",
        result: { status: "completed", stderr: "error output" },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns true for completed with observation", () => {
      const event = makeSessionEvent({
        function: "run_shell",
        result: { status: "completed", observation: "Ran successfully" },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });
  });

  describe("manage_todo", () => {
    it("returns false for running manage_todo", () => {
      const event = makeSessionEvent({
        function: "manage_todo",
        result: { status: "running" },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns true for completed manage_todo with result", () => {
      const event = makeSessionEvent({
        function: "manage_todo",
        result: { status: "completed", output: { todos: [] } },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns false for manage_todo with null result", () => {
      const event = makeSessionEvent({
        function: "manage_todo",
        result: null as unknown as Record<string, unknown>,
      });
      expect(willEventRenderContent(event)).toBe(false);
    });
  });

  describe("edit_file", () => {
    it("returns false for running edit_file", () => {
      const event = makeSessionEvent({
        function: "edit_file",
        result: { status: "running" },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns true for completed edit_file with result", () => {
      const event = makeSessionEvent({
        function: "edit_file",
        result: { status: "completed", output: { diff: "..." } },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });
  });

  describe("read_file", () => {
    it("returns false for running read_file", () => {
      const event = makeSessionEvent({
        function: "read_file",
        result: { status: "running" },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns true for completed read_file with result", () => {
      const event = makeSessionEvent({
        function: "read_file",
        result: { status: "completed", output: "file content" },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns false for read_file with null result", () => {
      const event = makeSessionEvent({
        function: "read_file",
        result: null as unknown as Record<string, unknown>,
      });
      expect(willEventRenderContent(event)).toBe(false);
    });
  });

  describe("apply_patch", () => {
    it("returns false for running apply_patch", () => {
      const event = makeSessionEvent({
        function: "apply_patch",
        result: { status: "running" },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns true for completed apply_patch with result", () => {
      const event = makeSessionEvent({
        function: "apply_patch",
        result: { status: "completed", content: "Patch applied" },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });
  });

  describe("create_plan", () => {
    it("returns true for interactive streaming draft tool calls", () => {
      const event = makeSessionEvent({
        action_type: "tool_call",
        function: "create_plan",
        displayStatus: "awaiting_user",
        args: { title: "Plan", streamContent: "draft" },
        result: {},
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns false for rehydrated plan approval events", () => {
      const event = makeSessionEvent({
        action_type: "plan_approval",
        function: "plan_approval",
        args: {
          planEventSource: "rehydrate",
          planId: "plan-1",
          planRevisionId: "call_1",
        },
        result: { status: "pending" },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns false for lifecycle-less completed raw create_plan calls", () => {
      const event = makeSessionEvent({
        action_type: "tool_call",
        function: "create_plan",
        displayStatus: "completed",
        args: { title: "Plan", streamContent: "draft" },
        result: {},
      });
      expect(willEventRenderContent(event)).toBe(false);
    });
  });

  describe("action registry and fallback", () => {
    it("returns true for registered function name (read_file completed)", () => {
      const event = makeSessionEvent({
        action_type: "tool_call",
        function: "read_file",
        result: { output: "content" },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns true for registered uiCanonical aliases with empty results", () => {
      const event = makeSessionEvent({
        action_type: "tool_call",
        function: "Grep",
        uiCanonical: "code_search",
        result: { success: true, matches: [] },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns true for unknown action_type with observation in result", () => {
      const event = makeSessionEvent({
        action_type: "custom_event",
        function: "",
        result: { observation: "Something happened" },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns false for unknown action_type without observation", () => {
      const event = makeSessionEvent({
        action_type: "custom_event",
        function: "",
        result: { some_data: "value" },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns false when observation is not a string", () => {
      const event = makeSessionEvent({
        action_type: "custom_event",
        function: "",
        result: { observation: 12345 },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });
  });

  describe("agent_message / assistant", () => {
    it("returns true for assistant with displayText", () => {
      const event = makeSessionEvent({
        action_type: "assistant",
        function: "assistant_message",
        displayText: "Hello",
        result: {},
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns true for agent_message with result.observation text", () => {
      const event = makeSessionEvent({
        action_type: "assistant",
        function: "agent_message",
        result: { observation: "answer body" },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns false for streaming delta without body", () => {
      const event = {
        ...makeSessionEvent({
          action_type: "assistant",
          function: "agent_message",
          result: {},
        }),
        isDelta: true,
      };
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns true when only result.content is populated", () => {
      const event = makeSessionEvent({
        action_type: "assistant",
        function: "agent_message",
        result: { content: "wrapped text" },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns true when observation is an object carrying a content string", () => {
      const event = makeSessionEvent({
        action_type: "assistant",
        function: "agent_message",
        result: { observation: { content: "answer" } },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns true when args.task_description is the only text source", () => {
      const event = makeSessionEvent({
        action_type: "assistant",
        function: "agent_message",
        args: { task_description: "delegated subtask" },
        result: {},
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns false for an empty non-streaming agent_message (prevents empty wrapper)", () => {
      const event = makeSessionEvent({
        action_type: "assistant",
        function: "agent_message",
        result: {},
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns false for an agent_message whose only text is empty <think> content", () => {
      const event = makeSessionEvent({
        action_type: "assistant",
        function: "agent_message",
        result: { observation: "<think>  \n  </think>" },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("returns true for an agent_message whose only text is non-empty <think> content", () => {
      const event = makeSessionEvent({
        action_type: "assistant",
        function: "agent_message",
        result: { observation: "<think>I need to inspect the repo.</think>" },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("returns false for an agent_message whose visible text is whitespace", () => {
      const event = makeSessionEvent({
        action_type: "assistant",
        function: "agent_message",
        displayText: "   ",
        result: { observation: "  \n  " },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });
  });

  describe("CLI alias resolution", () => {
    it("handles Shell alias (resolves to run_shell)", () => {
      const event = makeSessionEvent({
        function: "Shell",
        args: { command: "ls -la" },
        result: { status: "running" },
      });
      expect(willEventRenderContent(event)).toBe(true);
    });

    it("handles Edit alias (resolves to edit_file) running → false", () => {
      const event = makeSessionEvent({
        function: "Edit",
        result: { status: "running" },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });

    it("handles Read alias (resolves to read_file) running → false", () => {
      const event = makeSessionEvent({
        function: "Read",
        result: { status: "running" },
      });
      expect(willEventRenderContent(event)).toBe(false);
    });
  });
});
