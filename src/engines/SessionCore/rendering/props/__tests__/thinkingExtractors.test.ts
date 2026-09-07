import { describe, expect, it } from "vitest";

import { extractThinkingData } from "../thinkingExtractors";
import { makeUniversalProps } from "./fixtures";

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
