import { describe, expect, it } from "vitest";

import {
  extractFailureData,
  extractSuccessData,
  extractThinkingData,
  safeText,
} from "../propsDataExtractors";
import { makeUniversalProps } from "./fixtures";

// ============================================
// safeText
// ============================================

describe("safeText", () => {
  it("returns undefined for null/undefined/empty string/false/0", () => {
    expect(safeText(null)).toBeUndefined();
    expect(safeText(undefined)).toBeUndefined();
    expect(safeText("")).toBeUndefined();
    expect(safeText(0)).toBeUndefined();
    expect(safeText(false)).toBeUndefined();
  });

  it("returns the string directly for string input", () => {
    expect(safeText("hello world")).toBe("hello world");
    expect(safeText("multi\nline\ntext")).toBe("multi\nline\ntext");
  });

  it("extracts content from {content: string}", () => {
    expect(safeText({ content: "from content" })).toBe("from content");
  });

  it("extracts content from {role, content} format", () => {
    expect(safeText({ role: "assistant", content: "response text" })).toBe(
      "response text"
    );
  });

  it("extracts text from {text: string}", () => {
    expect(safeText({ text: "from text" })).toBe("from text");
  });

  it("extracts message from {message: string}", () => {
    expect(safeText({ message: "from message" })).toBe("from message");
  });

  it("prioritizes content over text over message", () => {
    expect(safeText({ content: "c", text: "t", message: "m" })).toBe("c");
    expect(safeText({ text: "t", message: "m" })).toBe("t");
  });

  it("extracts first viable item from arrays", () => {
    expect(safeText(["first string", "second"])).toBe("first string");
    expect(safeText([null, undefined, "third"])).toBe("third");
    expect(safeText([{ content: "nested" }, "plain"])).toBe("nested");
  });

  it("returns undefined for arrays with no extractable content", () => {
    expect(safeText([null, undefined, 0])).toBeUndefined();
    expect(safeText([])).toBeUndefined();
  });

  it("returns undefined for objects with no recognized keys", () => {
    expect(safeText({ foo: "bar", count: 42 })).toBeUndefined();
  });

  it("returns undefined for number input (truthy but not string/object-with-keys)", () => {
    expect(safeText(42)).toBeUndefined();
  });
});

// ============================================
// extractSuccessData / extractFailureData
// ============================================

describe("extractSuccessData", () => {
  it("returns empty object for undefined result", () => {
    expect(extractSuccessData(undefined)).toEqual({});
  });

  it("returns empty object when neither nested nor flat success exists", () => {
    expect(extractSuccessData({ someField: "value" })).toEqual({});
  });

  it("extracts nested result.output.success", () => {
    const result = {
      output: { success: { path: "/file.ts", content: "hello" } },
    };
    expect(extractSuccessData(result)).toEqual({
      path: "/file.ts",
      content: "hello",
    });
  });

  it("extracts flat result.success", () => {
    const result = { success: { path: "/file.ts", content: "hello" } };
    expect(extractSuccessData(result)).toEqual({
      path: "/file.ts",
      content: "hello",
    });
  });

  it("nested success takes priority over flat success", () => {
    const result = {
      output: { success: { source: "nested" } },
      success: { source: "flat" },
    };
    expect(extractSuccessData(result)).toEqual({ source: "nested" });
  });

  it("falls back to flat when nested success is empty object", () => {
    const result = {
      output: { success: {} },
      success: { source: "flat" },
    };
    expect(extractSuccessData(result)).toEqual({ source: "flat" });
  });
});

describe("extractFailureData", () => {
  it("returns empty object for undefined result", () => {
    expect(extractFailureData(undefined)).toEqual({});
  });

  it("extracts nested result.output.failure", () => {
    const result = {
      output: { failure: { error: "File not found", code: "ENOENT" } },
    };
    expect(extractFailureData(result)).toEqual({
      error: "File not found",
      code: "ENOENT",
    });
  });

  it("extracts flat result.failure", () => {
    const result = { failure: { error: "timeout" } };
    expect(extractFailureData(result)).toEqual({ error: "timeout" });
  });

  it("nested failure takes priority over flat failure", () => {
    const result = {
      output: { failure: { source: "nested" } },
      failure: { source: "flat" },
    };
    expect(extractFailureData(result)).toEqual({ source: "nested" });
  });
});

// ============================================
// extractThinkingData
// ============================================

describe("extractThinkingData", () => {
  it("returns content and duration as undefined when all sources are empty", () => {
    const props = makeUniversalProps({ args: {}, result: {} });
    const data = extractThinkingData(props);
    expect(data.content).toBeUndefined();
    expect(data.duration).toBeUndefined();
  });

  it("streamingContent takes top priority", () => {
    const props = makeUniversalProps({
      streamingContent: "streaming text",
      result: {
        thought: "thought text",
        content: "content text",
        observation: "obs text",
      },
      args: { content: "args content" },
    });
    expect(extractThinkingData(props).content).toBe("streaming text");
  });

  it("result.thought is next priority after streamingContent", () => {
    const props = makeUniversalProps({
      result: {
        thought: "thought text",
        content: "content text",
        observation: "obs text",
      },
      args: { content: "args content" },
    });
    expect(extractThinkingData(props).content).toBe("thought text");
  });

  it("result.content is next fallback", () => {
    const props = makeUniversalProps({
      result: { content: "content text", observation: "obs" },
      args: { content: "args content" },
    });
    expect(extractThinkingData(props).content).toBe("content text");
  });

  it("result.observation is next fallback", () => {
    const props = makeUniversalProps({
      result: { observation: "obs text" },
      args: { content: "args content" },
    });
    expect(extractThinkingData(props).content).toBe("obs text");
  });

  it("args.content is last fallback", () => {
    const props = makeUniversalProps({
      result: {},
      args: { content: "args content" },
    });
    expect(extractThinkingData(props).content).toBe("args content");
  });

  it("extracts legacy second duration from result", () => {
    const props = makeUniversalProps({ result: { duration: 3.5 } });
    expect(extractThinkingData(props).duration).toBe(3500);
  });

  it("extracts millisecond duration from result", () => {
    const props = makeUniversalProps({ result: { durationMs: 3500 } });
    expect(extractThinkingData(props).duration).toBe(3500);
  });

  it("duration is undefined when result.duration is 0", () => {
    const props = makeUniversalProps({ result: { duration: 0 } });
    expect(extractThinkingData(props).duration).toBeUndefined();
  });
});
