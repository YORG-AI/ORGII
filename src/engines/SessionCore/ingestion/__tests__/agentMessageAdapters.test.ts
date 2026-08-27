/**
 * Persisted-message → SessionEvent conversion contract.
 *
 * This is the ingestion boundary for rows the Rust `*_load_messages` commands
 * hand back: arbitrary role strings, nullable tool columns, JSON blobs written
 * by older schema versions. The tests below pin what the boundary does with
 * each malformed shape — reject, coerce, or pass through — so a future rewrite
 * cannot quietly change the answer.
 *
 * Only Tauri edges are mocked: `convertFileSrc` and the `mergeToolResults` RPC.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SessionEvent } from "../../core/types";
import {
  COMPACT_CONTINUATION_SUFFIX,
  type PersistedMessage,
  buildResult,
  compactBoundaryToSessionEvent,
  getActivityStatus,
  getDisplayStatus,
  getDisplayVariant,
  isCompactBoundaryContent,
  mergeToolResults,
  parseActivityImages,
  parseCompactBoundaryContent,
  persistedMessageToSessionEvent,
} from "../agentMessageAdapters";

const tauri = vi.hoisted(() => ({
  convertFileSrc: vi.fn((path: string) => `asset://localhost/${path}`),
  mergeToolResults: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: tauri.convertFileSrc,
}));

vi.mock("@src/api/tauri/rpc", () => ({
  rpc: {
    sessionCore: { eventStore: { mergeToolResults: tauri.mergeToolResults } },
  },
}));

const SESSION_ID = "agent-ingest";

function makeRow(overrides: Partial<PersistedMessage> = {}): PersistedMessage {
  return {
    id: "row-1",
    sessionId: SESSION_ID,
    role: "assistant",
    content: "hello",
    toolName: null,
    toolCallId: null,
    toolInput: null,
    toolOutput: null,
    model: null,
    sequence: 1,
    createdAt: "2026-08-01T00:00:00.000Z",
    images: null,
    ...overrides,
  };
}

describe("role classification helpers", () => {
  it.each([
    ["user", "message", "agent"],
    ["assistant", "message", "agent"],
    ["system", "message", "agent"],
    ["tool_call", "tool_call", "agent"],
    ["tool_result", "tool_call", "processed"],
  ] as const)(
    "maps role %s to variant %s / activity %s",
    (role, variant, activity) => {
      expect(getDisplayVariant(role)).toBe(variant);
      expect(getActivityStatus(role)).toBe(activity);
    }
  );

  it("treats an unknown role as a plain agent message", () => {
    const role = "definitely_new" as Parameters<typeof getDisplayVariant>[0];

    expect(getDisplayVariant(role)).toBe("message");
    expect(getActivityStatus(role)).toBe("agent");
  });
});

describe("getDisplayStatus", () => {
  it("prefers `running` while the message is still streaming", () => {
    expect(
      getDisplayStatus({
        id: "a",
        role: "system",
        content: "Error: boom",
        timestamp: 0,
        streaming: true,
      })
    ).toBe("running");
  });

  it("only marks an `Error:` prefix failed for the system role", () => {
    const base = { id: "a", content: "Error: boom", timestamp: 0 };

    expect(getDisplayStatus({ ...base, role: "system" })).toBe("failed");
    expect(getDisplayStatus({ ...base, role: "assistant" })).toBe("completed");
  });

  it("does not treat a mid-string `Error:` as a failure", () => {
    expect(
      getDisplayStatus({
        id: "a",
        role: "system",
        content: "note: Error: boom",
        timestamp: 0,
      })
    ).toBe("completed");
  });
});

describe("buildResult", () => {
  const base = { id: "a", content: "text", timestamp: 0 };

  it("wraps a user message in the `type: user` envelope", () => {
    expect(buildResult({ ...base, role: "user" })).toEqual({
      type: "user",
      message: { content: "text", role: "user" },
    });
  });

  it("uses `observation` for assistant and system prose", () => {
    expect(buildResult({ ...base, role: "assistant" })).toEqual({
      observation: "text",
    });
    expect(buildResult({ ...base, role: "system" })).toEqual({
      observation: "text",
    });
  });

  it("emits both `content` and `observation` for a tool result", () => {
    expect(buildResult({ ...base, role: "tool_result" })).toEqual({
      content: "text",
      observation: "text",
    });
  });

  it("emits an empty result for tool_call and for an unknown role", () => {
    expect(buildResult({ ...base, role: "tool_call" })).toEqual({});
    expect(
      buildResult({
        ...base,
        role: "brand_new" as Parameters<typeof buildResult>[0]["role"],
      })
    ).toEqual({});
  });
});

describe("compact-boundary detection and parsing", () => {
  it("recognizes both compactor header prefixes, and nothing else", () => {
    expect(isCompactBoundaryContent("[Conversation summary — 12 …]")).toBe(
      true
    );
    expect(isCompactBoundaryContent("[Session Memory — compacted]")).toBe(true);
    expect(isCompactBoundaryContent("Conversation summary")).toBe(false);
    expect(isCompactBoundaryContent("")).toBe(false);
    // Prefix match is anchored at the start: a quoted header mid-message is not
    // a boundary.
    expect(
      isCompactBoundaryContent("the log said [Conversation summary — 1]")
    ).toBe(false);
  });

  it("splits header from body and strips the model-facing continuation", () => {
    const content = [
      "[Conversation summary — 12 earlier messages compacted]",
      "We refactored the sync layer.",
      "",
      COMPACT_CONTINUATION_SUFFIX,
    ].join("\n");

    expect(parseCompactBoundaryContent(content)).toEqual({
      header: "[Conversation summary — 12 earlier messages compacted]",
      body: "We refactored the sync layer.",
      compactedCount: 12,
    });
  });

  it("handles a header-only row (compacted without summary)", () => {
    const content = "[Session Memory - compacted without summary]";

    expect(parseCompactBoundaryContent(content)).toEqual({
      header: "[Session Memory - compacted without summary]",
      body: "",
      compactedCount: null,
    });
  });

  it("returns a null header for content that is not a boundary at all", () => {
    expect(parseCompactBoundaryContent("  just prose  ")).toEqual({
      header: null,
      body: "just prose",
      compactedCount: null,
    });
  });

  it("leaves compactedCount null when the header carries no count", () => {
    const content = "[Conversation summary — compacted]\nbody";

    expect(parseCompactBoundaryContent(content).compactedCount).toBeNull();
  });
});

describe("compactBoundaryToSessionEvent", () => {
  it("routes the row to the dedicated renderer with a wire-safe variant", () => {
    const event = compactBoundaryToSessionEvent(
      makeRow({
        id: "compact-1",
        role: "system",
        content:
          "[Conversation summary — 8 earlier messages compacted]\nSummary body.",
        compactFromSequence: 40,
        compactTokensBefore: 90_000,
        compactTokensAfter: 12_000,
      }),
      SESSION_ID
    );

    expect(event).toMatchObject({
      id: "compact-1",
      chunk_id: "compact-1",
      sessionId: SESSION_ID,
      functionName: "context_compacted",
      actionType: "system",
      source: "system",
      // Must stay a value Rust's EventDisplayVariant serde enum accepts.
      displayVariant: "message",
      displayStatus: "completed",
      isDelta: false,
      displayText: "Summary body.",
      result: {
        observation: "Summary body.",
        header: "[Conversation summary — 8 earlier messages compacted]",
        compactedCount: 8,
        tokensBefore: 90_000,
        tokensAfter: 12_000,
      },
    });
  });

  it("omits the token pair unless both sides are present", () => {
    const event = compactBoundaryToSessionEvent(
      makeRow({
        role: "system",
        content: "[Session Memory — compacted]\nbody",
        compactTokensBefore: 100,
        compactTokensAfter: null,
      }),
      SESSION_ID
    );

    expect(event.result).not.toHaveProperty("tokensBefore");
    expect(event.result).not.toHaveProperty("tokensAfter");
  });

  it("falls back to the header for displayText when the body is empty", () => {
    const event = compactBoundaryToSessionEvent(
      makeRow({
        role: "system",
        content: "[Session Memory - compacted without summary]",
      }),
      SESSION_ID
    );

    expect(event.displayText).toBe(
      "[Session Memory - compacted without summary]"
    );
  });

  it("produces an empty displayText rather than undefined for a bodyless non-boundary row", () => {
    const event = compactBoundaryToSessionEvent(
      makeRow({ role: "system", content: "" }),
      SESSION_ID
    );

    expect(event.displayText).toBe("");
    expect(event.result).not.toHaveProperty("header");
  });
});

describe("persistedMessageToSessionEvent", () => {
  it("routes a row with compactFromSequence to the compact renderer", () => {
    const event = persistedMessageToSessionEvent(
      makeRow({
        role: "assistant",
        content: "[Conversation summary — 3 earlier messages compacted]\nb",
        compactFromSequence: 12,
      }),
      SESSION_ID
    );

    expect(event.functionName).toBe("context_compacted");
  });

  it("treats compactFromSequence 0 as authoritative, not as absent", () => {
    const event = persistedMessageToSessionEvent(
      makeRow({
        role: "assistant",
        content: "plain prose",
        compactFromSequence: 0,
      }),
      SESSION_ID
    );

    expect(event.functionName).toBe("context_compacted");
  });

  it("requires the system role for the legacy content-prefix fallback", () => {
    const content = "[Conversation summary — 3 earlier messages compacted]\nb";

    expect(
      persistedMessageToSessionEvent(
        makeRow({ role: "system", content }),
        SESSION_ID
      ).functionName
    ).toBe("context_compacted");
    expect(
      persistedMessageToSessionEvent(
        makeRow({ role: "assistant", content }),
        SESSION_ID
      ).functionName
    ).toBe("assistant_message");
  });

  it("converts a user row into the user envelope with actionType raw", () => {
    const event = persistedMessageToSessionEvent(
      makeRow({ id: "u1", role: "user", content: "do the thing" }),
      SESSION_ID
    );

    expect(event).toMatchObject({
      id: "u1",
      chunk_id: "u1",
      sessionId: SESSION_ID,
      actionType: "raw",
      source: "user",
      functionName: "user_input",
      displayVariant: "message",
      activityStatus: "agent",
      displayText: "do the thing",
      isDelta: false,
      result: {
        type: "user",
        message: { content: "do the thing", role: "user" },
      },
    });
    expect(event.callId).toBeUndefined();
    expect(event.result).not.toHaveProperty("images");
  });

  it("prefers toolOutput over content for a tool_result row", () => {
    const event = persistedMessageToSessionEvent(
      makeRow({
        role: "tool_result",
        content: "ignored preview",
        toolOutput: "real output",
        toolName: "read_file",
        toolCallId: "call-1",
      }),
      SESSION_ID
    );

    expect(event.result).toEqual({
      content: "real output",
      observation: "real output",
    });
    expect(event).toMatchObject({
      actionType: "tool_result",
      functionName: "read_file",
      callId: "call-1",
      activityStatus: "processed",
      displayVariant: "tool_call",
    });
  });

  it("falls back to content when toolOutput is null", () => {
    const event = persistedMessageToSessionEvent(
      makeRow({ role: "tool_result", content: "fallback", toolOutput: null }),
      SESSION_ID
    );

    expect(event.result).toEqual({
      content: "fallback",
      observation: "fallback",
    });
  });

  it("leaves the result empty for a tool_call row", () => {
    const event = persistedMessageToSessionEvent(
      makeRow({
        role: "tool_call",
        toolName: "bash",
        toolCallId: "call-2",
        toolInput: '{"command":"ls"}',
      }),
      SESSION_ID
    );

    expect(event.result).toEqual({});
    expect(event.args).toEqual({ command: "ls" });
    expect(event.actionType).toBe("tool_call");
  });

  it("quarantines an unparsable toolInput under `raw` instead of throwing", () => {
    const event = persistedMessageToSessionEvent(
      makeRow({ role: "tool_call", toolInput: "{not json" }),
      SESSION_ID
    );

    expect(event.args).toEqual({ raw: "{not json" });
  });

  it("quarantines valid JSON that is not an object", () => {
    for (const toolInput of ["[1,2,3]", '"a string"', "42", "null"]) {
      const event = persistedMessageToSessionEvent(
        makeRow({ role: "tool_call", toolInput }),
        SESSION_ID
      );

      expect(event.args).toEqual({ raw: toolInput });
    }
  });

  it("treats an empty toolInput as no args at all", () => {
    const event = persistedMessageToSessionEvent(
      makeRow({ role: "tool_call", toolInput: "" }),
      SESSION_ID
    );

    expect(event.args).toEqual({});
  });

  it("attaches parsed images to a user row and omits the key when there are none", () => {
    const withImages = persistedMessageToSessionEvent(
      makeRow({
        role: "user",
        images: JSON.stringify(["data:image/png;base64,AAA", "/tmp/shot.png"]),
      }),
      SESSION_ID
    );

    expect(withImages.result).toMatchObject({
      images: ["data:image/png;base64,AAA", "asset://localhost//tmp/shot.png"],
    });

    const emptyImages = persistedMessageToSessionEvent(
      makeRow({ role: "user", images: "[]" }),
      SESSION_ID
    );
    expect(emptyImages.result).not.toHaveProperty("images");
  });

  it("does not attach images to a non-user row", () => {
    const event = persistedMessageToSessionEvent(
      makeRow({
        role: "assistant",
        images: JSON.stringify(["/tmp/shot.png"]),
      }),
      SESSION_ID
    );

    expect(event.result).toEqual({ observation: "hello" });
  });

  it("applies a caller-supplied displayText transform without touching result", () => {
    const event = persistedMessageToSessionEvent(
      makeRow({ role: "assistant", content: "raw prose" }),
      SESSION_ID,
      {
        transformDisplayText: (content, source) =>
          `${source}:${content.toUpperCase()}`,
      }
    );

    expect(event.displayText).toBe("assistant:RAW PROSE");
    expect(event.result).toEqual({ observation: "raw prose" });
  });

  it("maps an unrecognized role onto the assistant lane", () => {
    const event = persistedMessageToSessionEvent(
      makeRow({ role: "sidechannel", content: "?" }),
      SESSION_ID
    );

    expect(event).toMatchObject({
      actionType: "assistant",
      source: "assistant",
      functionName: "assistant_message",
      displayVariant: "message",
      activityStatus: "agent",
    });
    // The assistant branch is keyed on the literal role, so an unknown role
    // yields an empty result rather than an observation.
    expect(event.result).toEqual({});
  });

  it("uses the session id argument, not the row's own sessionId column", () => {
    const event = persistedMessageToSessionEvent(
      makeRow({ sessionId: "row-says-other" }),
      SESSION_ID
    );

    expect(event.sessionId).toBe(SESSION_ID);
  });
});

describe("parseActivityImages", () => {
  beforeEach(() => {
    tauri.convertFileSrc.mockClear();
  });

  it("returns undefined for null and for a blank string", () => {
    expect(parseActivityImages(null)).toBeUndefined();
    expect(parseActivityImages("")).toBeUndefined();
  });

  it("passes data URLs through untouched and converts file paths", () => {
    expect(
      parseActivityImages(
        JSON.stringify(["data:image/png;base64,AAA", "/tmp/a.png"])
      )
    ).toEqual(["data:image/png;base64,AAA", "asset://localhost//tmp/a.png"]);
    expect(tauri.convertFileSrc).toHaveBeenCalledTimes(1);
  });

  it("returns undefined for malformed JSON rather than throwing", () => {
    expect(parseActivityImages("[not json")).toBeUndefined();
  });

  it("rejects a JSON array containing non-strings", () => {
    expect(
      parseActivityImages(JSON.stringify(["/tmp/a.png", 7]))
    ).toBeUndefined();
    expect(parseActivityImages(JSON.stringify({ a: 1 }))).toBeUndefined();
  });
});

describe("mergeToolResults", () => {
  beforeEach(() => {
    tauri.mergeToolResults.mockReset();
  });

  it("short-circuits an empty list without an RPC round-trip", async () => {
    const input: SessionEvent[] = [];

    await expect(mergeToolResults(input)).resolves.toBe(input);
    expect(tauri.mergeToolResults).not.toHaveBeenCalled();
  });

  it("returns exactly what Rust hands back", async () => {
    const merged = [
      persistedMessageToSessionEvent(makeRow({ id: "merged" }), SESSION_ID),
    ];
    tauri.mergeToolResults.mockResolvedValue(merged);
    const input = [
      persistedMessageToSessionEvent(makeRow({ id: "in" }), SESSION_ID),
    ];

    await expect(mergeToolResults(input)).resolves.toBe(merged);
    expect(tauri.mergeToolResults).toHaveBeenCalledWith({ events: input });
  });
});
