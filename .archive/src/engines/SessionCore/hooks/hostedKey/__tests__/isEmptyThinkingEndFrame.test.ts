/**
 * isEmptyThinkingEndFrame — unit tests
 *
 * Regression target:
 *   The hosted-key activity sync used to push every WebSocket event
 *   into `eventBufferRef` BEFORE evaluating the "empty thinking end
 *   marker" predicate. As a result, frames that the UI deliberately
 *   filtered out still ended up in the persisted activity log via
 *   the periodic flush. On replay (e.g. a different device, a session
 *   reload), the user saw extra orphan thinking blocks that had been
 *   invisible on the original render.
 *
 *   Centralizing the predicate as a pure function and applying it
 *   BEFORE the buffer push removes the skew. These tests pin down the
 *   contract so a future refactor can't quietly re-introduce the gap.
 */
import { describe, expect, it } from "vitest";

import type { HostedKeyActivityEvent } from "@src/api/http/session/hostedKey";

import { isEmptyThinkingEndFrame } from "../useHostedKeyActivitySync";

function makeEvent(chunk: unknown): HostedKeyActivityEvent {
  return {
    event_id: "evt-1",
    event_type: "session.activity",
    created_at: new Date().toISOString(),
    data: { chunk },
  } as HostedKeyActivityEvent;
}

describe("isEmptyThinkingEndFrame — true cases", () => {
  it("returns true for llm_thinking with no content and is_delta=false", () => {
    expect(
      isEmptyThinkingEndFrame(
        makeEvent({
          chunk_id: "c1",
          action_type: "llm_thinking",
          function: "thinking",
          args: {},
          result: { is_delta: false },
        })
      )
    ).toBe(true);
  });

  it("returns true for thinking with whitespace-only content", () => {
    expect(
      isEmptyThinkingEndFrame(
        makeEvent({
          chunk_id: "c1",
          action_type: "thinking",
          function: "thinking",
          args: {},
          result: { thought: "   ", content: "\n\t", observation: " " },
        })
      )
    ).toBe(true);
  });

  it("returns true when is_delta key is absent and content is empty", () => {
    expect(
      isEmptyThinkingEndFrame(
        makeEvent({
          chunk_id: "c1",
          action_type: "llm_thinking",
          function: "thinking",
          args: {},
          result: {},
        })
      )
    ).toBe(true);
  });
});

describe("isEmptyThinkingEndFrame — false cases (content present)", () => {
  it("returns false when result.thought has content", () => {
    expect(
      isEmptyThinkingEndFrame(
        makeEvent({
          chunk_id: "c1",
          action_type: "llm_thinking",
          function: "thinking",
          args: {},
          result: { thought: "Let me think..." },
        })
      )
    ).toBe(false);
  });

  it("returns false when result.content has content", () => {
    expect(
      isEmptyThinkingEndFrame(
        makeEvent({
          chunk_id: "c1",
          action_type: "thinking",
          function: "thinking",
          args: {},
          result: { content: "step 1" },
        })
      )
    ).toBe(false);
  });

  it("returns false when result.observation has content", () => {
    expect(
      isEmptyThinkingEndFrame(
        makeEvent({
          chunk_id: "c1",
          action_type: "thinking",
          function: "thinking",
          args: {},
          result: { observation: "decided to call X" },
        })
      )
    ).toBe(false);
  });
});

describe("isEmptyThinkingEndFrame — false cases (is_delta=true)", () => {
  it("returns false for any thinking frame that is a delta", () => {
    expect(
      isEmptyThinkingEndFrame(
        makeEvent({
          chunk_id: "c1",
          action_type: "llm_thinking",
          function: "thinking",
          args: {},
          result: { is_delta: true },
        })
      )
    ).toBe(false);
  });

  it("returns false even for delta with empty content", () => {
    // Delta frames may legitimately be empty (e.g. agent emitted a
    // single space) — we still want to render them so the UI shows
    // the thinking-in-progress indicator. The filter is specifically
    // for *terminator* frames.
    expect(
      isEmptyThinkingEndFrame(
        makeEvent({
          chunk_id: "c1",
          action_type: "thinking",
          function: "thinking",
          args: {},
          result: { is_delta: true, content: "" },
        })
      )
    ).toBe(false);
  });
});

describe("isEmptyThinkingEndFrame — false cases (non-thinking action type)", () => {
  it("returns false for assistant message events", () => {
    expect(
      isEmptyThinkingEndFrame(
        makeEvent({
          chunk_id: "c1",
          action_type: "assistant",
          function: "assistant_message",
          args: {},
          result: { content: "Here's the answer." },
        })
      )
    ).toBe(false);
  });

  it("returns false for shell tool calls", () => {
    expect(
      isEmptyThinkingEndFrame(
        makeEvent({
          chunk_id: "c1",
          action_type: "tool_call",
          function: "run_shell",
          args: { command: "ls" },
          result: {},
        })
      )
    ).toBe(false);
  });

  it("returns false for assistant with empty content (NOT a thinking end marker)", () => {
    // An empty assistant message is a real bug elsewhere — but it is
    // NOT what this predicate filters. Only thinking-typed frames count.
    expect(
      isEmptyThinkingEndFrame(
        makeEvent({
          chunk_id: "c1",
          action_type: "assistant",
          function: "assistant_message",
          args: {},
          result: {},
        })
      )
    ).toBe(false);
  });
});

describe("isEmptyThinkingEndFrame — degenerate inputs", () => {
  it("returns false when the event has no extractable chunk", () => {
    const event: HostedKeyActivityEvent = {
      event_id: "evt-1",
      event_type: "session.status_changed",
      created_at: new Date().toISOString(),
      data: {},
    } as HostedKeyActivityEvent;
    expect(isEmptyThinkingEndFrame(event)).toBe(false);
  });

  it("returns true when a thinking chunk has no result field at all", () => {
    // No result → no `is_delta`, no thinking content → matches the
    // "empty terminator" shape. This is the same payload Rust emits
    // for the close of a thinking stream that had no incremental
    // content, just expressed with the optional field omitted.
    expect(
      isEmptyThinkingEndFrame(
        makeEvent({
          chunk_id: "c1",
          action_type: "llm_thinking",
          function: "thinking",
          args: {},
        })
      )
    ).toBe(true);
  });

  it("returns false when a NON-thinking chunk has no result field", () => {
    // Same shape but action_type is not a thinking variant — the
    // predicate must NOT match, otherwise we'd accidentally swallow
    // empty tool calls / status events as well.
    expect(
      isEmptyThinkingEndFrame(
        makeEvent({
          chunk_id: "c1",
          action_type: "tool_call",
          function: "run_shell",
          args: {},
        })
      )
    ).toBe(false);
  });
});

describe("isEmptyThinkingEndFrame — pure & idempotent", () => {
  it("is idempotent: same input yields same output across calls", () => {
    const event = makeEvent({
      chunk_id: "c1",
      action_type: "llm_thinking",
      function: "thinking",
      args: {},
      result: { is_delta: false },
    });
    const first = isEmptyThinkingEndFrame(event);
    const second = isEmptyThinkingEndFrame(event);
    const third = isEmptyThinkingEndFrame(event);
    expect(first).toBe(true);
    expect(second).toBe(true);
    expect(third).toBe(true);
  });

  it("does not mutate the input event", () => {
    const result = {
      thought: "",
      content: "",
      observation: "",
      is_delta: false,
    };
    const event = makeEvent({
      chunk_id: "c1",
      action_type: "llm_thinking",
      function: "thinking",
      args: {},
      result,
    });
    const snapshot = JSON.parse(JSON.stringify(event));
    isEmptyThinkingEndFrame(event);
    expect(event).toEqual(snapshot);
  });
});
