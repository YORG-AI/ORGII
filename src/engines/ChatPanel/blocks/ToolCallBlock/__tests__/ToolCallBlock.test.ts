import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ToolCallBlock from "..";

vi.mock("@src/engines/ChatPanel/hooks/useChatEventReplay", () => ({
  useChatEventReplay: () => ({
    replayEventById: vi.fn(),
    canReplay: false,
  }),
}));

describe("ToolCallBlock collapse defaults", () => {
  it("hides raw input and output by default", () => {
    const markup = renderToStaticMarkup(
      createElement(ToolCallBlock, {
        toolName: "raw_tool",
        args: { value: "raw input details" },
        result: { observation: "raw output details" },
      })
    );

    expect(markup).toContain('data-tool-call-name="raw_tool"');
    expect(markup).not.toContain("raw input details");
    expect(markup).not.toContain("raw output details");
  });

  it("honors an explicit expanded default", () => {
    const markup = renderToStaticMarkup(
      createElement(ToolCallBlock, {
        toolName: "raw_tool",
        args: { value: "raw input details" },
        result: { observation: "raw output details" },
        defaultCollapsed: false,
      })
    );

    expect(markup).toContain("raw input details");
    expect(markup).toContain("raw output details");
  });
});
