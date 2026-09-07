// @vitest-environment node
import { describe, expect, it } from "vitest";

import { SessionMessageSchema } from "../agentSession";

describe("SessionMessageSchema", () => {
  it("normalizes nullable Rust tool fields on ordinary messages", () => {
    expect(
      SessionMessageSchema.parse({
        id: "message-1",
        role: "assistant",
        content: "done",
        toolName: null,
        toolInput: null,
        createdAt: "2026-08-26T00:00:00.000Z",
      })
    ).toMatchObject({
      id: "message-1",
      role: "assistant",
      content: "done",
      toolName: undefined,
      toolInput: undefined,
    });
  });

  it("preserves native tool metadata", () => {
    expect(
      SessionMessageSchema.parse({
        id: "message-2",
        role: "tool_call",
        content: "Tool call: read_file",
        toolName: "read_file",
        toolInput: '{"file_path":"README.md"}',
        createdAt: "2026-08-26T00:00:00.000Z",
      })
    ).toMatchObject({
      toolName: "read_file",
      toolInput: '{"file_path":"README.md"}',
    });
  });
});
