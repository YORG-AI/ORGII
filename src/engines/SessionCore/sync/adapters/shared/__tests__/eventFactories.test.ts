/**
 * SessionEvent factory contract.
 *
 * Every adapter composes these instead of hand-rolling event shapes, so the
 * factories are the last place a required domain field can be lost. The tests
 * below pin the invariants the rest of the pipeline depends on: `id === chunk_id`,
 * wire-safe `displayVariant` values (Rust's serde enum rejects unknown ones),
 * `callId` never synthesized, and the exact `args` keys that survive an
 * `undefined` optional.
 *
 * These are pure functions — nothing is mocked.
 */
import { describe, expect, it, vi } from "vitest";

import {
  isSyntheticUserInputEvent,
  parseActivityId,
} from "@src/engines/SessionCore/sync/utils/activityIds";

import {
  createSyntheticUserEvent,
  makeAssistantEvent,
  makeErrorEvent,
  makeRateLimitHintEvent,
  makeSummaryEvent,
  makeThinkingEvent,
  makeToolCallEvent,
  makeToolResultEvent,
  mintTurnIntentId,
} from "../eventFactories";

const SESSION_ID = "cliagent-factories";

/** Every durable SessionEvent must be addressable by the same id twice over. */
function expectSelfConsistentId(event: {
  id: string;
  chunk_id: string | null;
}) {
  expect(event.id).not.toBe("");
  expect(event.chunk_id).toBe(event.id);
}

describe("makeAssistantEvent", () => {
  it("produces a completed message event with matching id fields", () => {
    const event = makeAssistantEvent("evt-1", SESSION_ID, "Done.", false);

    expectSelfConsistentId(event);
    expect(event).toMatchObject({
      id: "evt-1",
      sessionId: SESSION_ID,
      functionName: "assistant_message",
      actionType: "assistant",
      source: "assistant",
      displayVariant: "message",
      displayStatus: "completed",
      activityStatus: "agent",
      displayText: "Done.",
      result: { observation: "Done." },
      isDelta: false,
    });
    expect(Number.isNaN(Date.parse(event.createdAt))).toBe(false);
  });

  it("marks a streaming event running and delta", () => {
    const event = makeAssistantEvent("evt-2", SESSION_ID, "partial", true);

    expect(event.displayStatus).toBe("running");
    expect(event.isDelta).toBe(true);
  });

  it("strips inline think tags from both the body and the display text", () => {
    const event = makeAssistantEvent(
      "evt-3",
      SESSION_ID,
      "before<think>hidden reasoning</think>after",
      false
    );

    expect(event.displayText).toBe("beforeafter");
    expect(event.result).toEqual({ observation: "beforeafter" });
  });

  it("drops an unclosed think tag and everything after it", () => {
    const event = makeAssistantEvent(
      "evt-4",
      SESSION_ID,
      "visible<think>still thinking",
      true
    );

    expect(event.displayText).toBe("visible");
  });

  it("keeps an empty body rather than substituting a placeholder", () => {
    const event = makeAssistantEvent("evt-5", SESSION_ID, "", false);

    expect(event.displayText).toBe("");
    expect(event.result).toEqual({ observation: "" });
  });
});

describe("makeThinkingEvent", () => {
  it("uses the delta action type only while streaming", () => {
    expect(makeThinkingEvent("t1", SESSION_ID, "why", true)).toMatchObject({
      actionType: "llm_thinking_delta",
      displayStatus: "running",
      isDelta: true,
    });
    expect(makeThinkingEvent("t2", SESSION_ID, "why", false)).toMatchObject({
      actionType: "llm_thinking",
      displayStatus: "completed",
      isDelta: false,
    });
  });

  it("routes to the thinking renderer with the raw text preserved", () => {
    // Deliberate asymmetry with makeAssistantEvent: thinking content is the
    // reasoning, so `<think>` markup is NOT stripped here.
    const event = makeThinkingEvent(
      "t3",
      SESSION_ID,
      "<think>nested</think>",
      false
    );

    expectSelfConsistentId(event);
    expect(event.displayVariant).toBe("thinking");
    expect(event.displayText).toBe("<think>nested</think>");
    expect(event.result).toEqual({ observation: "<think>nested</think>" });
  });
});

describe("makeToolCallEvent", () => {
  it("starts a normal tool call in the running phase", () => {
    const event = makeToolCallEvent(
      "tool-call-1",
      SESSION_ID,
      "read_file",
      "call-1",
      { file_path: "/tmp/a.txt" }
    );

    expectSelfConsistentId(event);
    expect(event).toMatchObject({
      functionName: "read_file",
      uiCanonical: "read_file",
      actionType: "tool_call",
      displayVariant: "tool_call",
      displayStatus: "running",
      activityStatus: "agent",
      callId: "call-1",
      filePath: "/tmp/a.txt",
      displayText: "Calling read_file...",
      result: {},
      isDelta: false,
    });
  });

  it("parks an interactive tool in awaiting_user so generic completion skips it", () => {
    for (const tool of [
      "ask_user_questions",
      "ask_user_permissions",
      "suggest_mode_switch",
      "create_plan",
      "mcp_orgii_suggest_mode_switch",
    ]) {
      expect(
        makeToolCallEvent("id", SESSION_ID, tool, "call", {}).displayStatus
      ).toBe("awaiting_user");
    }
  });

  it("falls back to a generic tool name when none is supplied", () => {
    for (const toolName of [undefined, ""]) {
      const event = makeToolCallEvent("id", SESSION_ID, toolName, "call", {});

      expect(event.functionName).toBe("tool_call");
      expect(event.displayText).toBe("Calling tool_call...");
    }
  });

  it("resolves a provider alias to the canonical renderer key", () => {
    const event = makeToolCallEvent("id", SESSION_ID, "Read", "call", {});

    expect(event.functionName).toBe("Read");
    expect(event.uiCanonical).toBe("read_file");
  });

  it("derives filePath from file_path, then path, then target_file", () => {
    const pick = (args: Record<string, unknown>) =>
      makeToolCallEvent("id", SESSION_ID, "edit", "call", args).filePath;

    expect(pick({ file_path: "/a", path: "/b", target_file: "/c" })).toBe("/a");
    expect(pick({ path: "/b", target_file: "/c" })).toBe("/b");
    expect(pick({ target_file: "/c" })).toBe("/c");
  });

  it("leaves filePath undefined for absent or non-string path args", () => {
    const pick = (args: Record<string, unknown>) =>
      makeToolCallEvent("id", SESSION_ID, "edit", "call", args).filePath;

    expect(pick({})).toBeUndefined();
    expect(pick({ file_path: 42 })).toBeUndefined();
    expect(pick({ file_path: null, path: ["/b"] })).toBeUndefined();
  });

  it("passes the args object through untouched", () => {
    const args = { command: "ls -la", nested: { deep: true } };
    const event = makeToolCallEvent("id", SESSION_ID, "bash", "call", args);

    expect(event.args).toBe(args);
  });

  it("records a missing tool call id as undefined rather than inventing one", () => {
    const event = makeToolCallEvent("id", SESSION_ID, "bash", undefined, {});

    expect(event.callId).toBeUndefined();
  });

  it("marks the event as a delta only when told to", () => {
    expect(
      makeToolCallEvent("id", SESSION_ID, "bash", "call", {}, true).isDelta
    ).toBe(true);
  });
});

describe("makeToolResultEvent", () => {
  it("keys the result on the tool call id so Rust can pair it", () => {
    const event = makeToolResultEvent(
      SESSION_ID,
      "read_file",
      "call-42",
      "file contents"
    );

    expectSelfConsistentId(event);
    expect(event).toMatchObject({
      id: "tool-result-call-42",
      callId: "call-42",
      functionName: "read_file",
      actionType: "tool_result",
      displayVariant: "tool_call",
      displayStatus: "completed",
      activityStatus: "processed",
      displayText: "file contents",
      result: { content: "file contents", observation: "file contents" },
    });
  });

  it("falls back to a generic function name", () => {
    const event = makeToolResultEvent(SESSION_ID, undefined, "call-7", "");

    expect(event.functionName).toBe("tool_call");
    expect(event.id).toBe("tool-result-call-7");
    expect(event.callId).toBe("call-7");
  });

  it("never substitutes a wall-clock id for an empty tool call id", () => {
    // The invariant the factory's JSDoc names: a `toolCallId || Date.now()`
    // fallback pairs with no tool_call in `merge_events` and leaks a zombie
    // row. The previous version of this test only passed "call-7" — a
    // non-empty id — so the fallback branch it claimed to guard never ran.
    const event = makeToolResultEvent(SESSION_ID, "read_file", "", "output");

    expect(event.id).toBe("tool-result-");
    expect(event.chunk_id).toBe("tool-result-");
    expect(event.callId).toBe("");
    // A synthesized id would be a timestamp, not the bare prefix.
    expect(event.id).not.toMatch(/\d/);
  });
});

describe("makeSummaryEvent", () => {
  it("keys the summary on the turn id and keeps only supplied metrics", () => {
    const event = makeSummaryEvent(SESSION_ID, "Did the thing", 3, 12.5, {
      turnId: "turn-9",
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    expectSelfConsistentId(event);
    expect(event).toMatchObject({
      id: "summary-turn-9",
      createdAt: "2026-08-01T00:00:00.000Z",
      functionName: "turn_summary",
      uiCanonical: "turn_summary",
      displayVariant: "summary",
      activityStatus: "processed",
      displayText: "Did the thing",
      result: { observation: "Did the thing" },
    });
    expect(event.args).toEqual({
      turnId: "turn-9",
      toolCalls: 3,
      wallTimeSecs: 12.5,
    });
  });

  it("omits undefined metrics instead of writing undefined values", () => {
    const event = makeSummaryEvent(SESSION_ID, "s", undefined, undefined, {
      turnId: "turn-9",
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    expect(event.args).toEqual({ turnId: "turn-9" });
    expect(Object.keys(event.args)).toEqual(["turnId"]);
  });

  it("keeps a zero metric — zero tool calls is a fact, not an absence", () => {
    const event = makeSummaryEvent(SESSION_ID, "s", 0, 0, {
      turnId: "turn-9",
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    expect(event.args).toMatchObject({ toolCalls: 0, wallTimeSecs: 0 });
  });
});

describe("makeErrorEvent", () => {
  it("renders a bare string error", () => {
    const event = makeErrorEvent(SESSION_ID, "boom", "error-fixed");

    expectSelfConsistentId(event);
    expect(event).toMatchObject({
      id: "error-fixed",
      functionName: "system",
      displayStatus: "failed",
      displayVariant: "message",
      displayText: "Error: boom",
      result: { observation: "Error: boom" },
    });
    expect(event.args).toEqual({});
  });

  it("mints a wall-clock id only when the caller supplies none", () => {
    const event = makeErrorEvent(SESSION_ID, "boom");

    expect(event.id).toMatch(/^error-\d+$/);
    expect(event.chunk_id).toBe(event.id);
  });

  it("carries structured error metadata into args", () => {
    const event = makeErrorEvent(SESSION_ID, {
      error: "rate limited",
      errorCode: "RATE_LIMIT",
      isRetryable: true,
      details: { retryAfterSecs: 30, toolName: "bash" },
    });

    expect(event.args).toEqual({
      errorCode: "RATE_LIMIT",
      isRetryable: true,
      details: { retryAfterSecs: 30, toolName: "bash" },
    });
    expect(event.displayText).toBe("Error: rate limited");
  });

  it("omits falsy metadata rather than writing `isRetryable: false`", () => {
    const event = makeErrorEvent(SESSION_ID, {
      error: "fatal",
      isRetryable: false,
      errorCode: "",
    });

    expect(event.args).toEqual({});
  });
});

describe("makeRateLimitHintEvent", () => {
  it("stays a neutral system card, not assistant prose", () => {
    const event = makeRateLimitHintEvent(SESSION_ID);

    expectSelfConsistentId(event);
    expect(event).toMatchObject({
      sessionId: SESSION_ID,
      functionName: "system",
      uiCanonical: "rate_limit_hint",
      actionType: "system",
      source: "system",
      // Wire-safe: Rust's EventDisplayVariant serde enum rejects unknowns.
      displayVariant: "message",
      displayStatus: "completed",
      displayText: "",
    });
    expect(event.result).toEqual({});
    expect(event.id).toMatch(/^rate-limit-hint-\d+$/);
  });
});

describe("mintTurnIntentId", () => {
  it("mints distinct ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => mintTurnIntentId()));

    expect(ids.size).toBe(50);
  });

  it("falls back to a timestamped id when crypto.randomUUID is unavailable", () => {
    const original = globalThis.crypto;
    // Node keeps `crypto` non-writable on globalThis; redefine it for the test.
    Object.defineProperty(globalThis, "crypto", {
      value: {},
      configurable: true,
      writable: true,
    });
    try {
      const id = mintTurnIntentId();

      expect(id).toMatch(/^tii-\d+-[a-z0-9]+$/);
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: original,
        configurable: true,
        writable: true,
      });
    }
  });
});

describe("createSyntheticUserEvent", () => {
  it("is recognizable as synthetic by the shared identity predicate", () => {
    const event = createSyntheticUserEvent(SESSION_ID, "do the thing");

    expect(isSyntheticUserInputEvent(event)).toBe(true);
    expect(event).toMatchObject({
      sessionId: SESSION_ID,
      functionName: "user_message",
      actionType: "raw",
      source: "user",
      displayText: "do the thing",
      displayStatus: "completed",
      displayVariant: "message",
      isDelta: false,
    });
    expect(event.result).toEqual({
      type: "user",
      message: { content: "do the thing", role: "user" },
      syntheticUserInput: true,
    });
  });

  it("carries a null chunk_id — it has no backend row yet", () => {
    const event = createSyntheticUserEvent(SESSION_ID, "hi");

    expect(event.chunk_id).toBeNull();
    expect(event.id.startsWith("user-input-")).toBe(true);
    // Legacy-format id: not a `prefix:source:identifier` activity id.
    expect(parseActivityId(event.id).isValid).toBe(false);
  });

  it("mints a distinct id per submit", () => {
    const ids = new Set(
      Array.from(
        { length: 25 },
        () => createSyntheticUserEvent(SESSION_ID, "x").id
      )
    );

    expect(ids.size).toBe(25);
  });

  it("threads the turn intent id and images only when supplied", () => {
    const withOptions = createSyntheticUserEvent(SESSION_ID, "look", {
      createdAt: "2026-08-01T00:00:00.000Z",
      imageDataUrls: ["data:image/png;base64,AAA"],
      turnIntentId: "tii-1",
    });

    expect(withOptions.createdAt).toBe("2026-08-01T00:00:00.000Z");
    expect(withOptions.result).toMatchObject({
      images: ["data:image/png;base64,AAA"],
      turnIntentId: "tii-1",
    });

    const withEmpties = createSyntheticUserEvent(SESSION_ID, "look", {
      imageDataUrls: [],
      turnIntentId: "",
    });

    expect(withEmpties.result).not.toHaveProperty("images");
    expect(withEmpties.result).not.toHaveProperty("turnIntentId");
  });

  it("defaults createdAt to now when the caller supplies none", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T12:00:00.000Z"));
    try {
      const event = createSyntheticUserEvent(SESSION_ID, "x");

      expect(event.createdAt).toBe("2026-08-01T12:00:00.000Z");
    } finally {
      vi.useRealTimers();
    }
  });
});
