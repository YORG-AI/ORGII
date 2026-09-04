import { describe, expect, it } from "vitest";

import { projectOutgoingUserMessage } from "../projectOutgoingUserMessage";

describe("projectOutgoingUserMessage", () => {
  it("returns no agent copy when nothing needs projecting", () => {
    const projection = projectOutgoingUserMessage({
      displayText: "just a plain message",
    });
    expect(projection.displayContent).toBe("just a plain message");
    expect(projection.agentContent).toBeUndefined();
  });

  it.each([true, false])(
    "removes leading blank lines even with agent interceptors set to %s",
    (enableAgentInterceptors) => {
      const projection = projectOutgoingUserMessage({
        displayText: "\r\n \t\r\n    first line\n\n  second line\n",
        enableAgentInterceptors,
      });
      expect(projection.displayContent).toBe(
        "    first line\n\n  second line\n"
      );
      expect(projection.agentContent).toBeUndefined();
    }
  );

  it("normalizes both copies before appending agent context", () => {
    expect(
      projectOutgoingUserMessage({
        displayText: "\n\n    inspect this\n\n  next line",
        contextBlocks: ["```\nserver ready\n```"],
      })
    ).toEqual({
      displayContent: "    inspect this\n\n  next line",
      agentContent: "    inspect this\n\n  next line\n\n```\nserver ready\n```",
    });
  });

  it("does not introduce a leading blank line for context-only input", () => {
    expect(
      projectOutgoingUserMessage({
        displayText: "\n \t",
        contextBlocks: ["```\nserver ready\n```"],
      })
    ).toEqual({
      displayContent: "",
      agentContent: "```\nserver ready\n```",
    });
  });

  it("expands skill pills for the agent while keeping the display copy", () => {
    const projection = projectOutgoingUserMessage({
      displayText: "statusline [skill:/statusline] please",
    });
    expect(projection.displayContent).toBe(
      "statusline [skill:/statusline] please"
    );
    expect(projection.agentContent).toBe("/statusline please");
  });

  it("strips editor-internal base64 pill payloads from the agent copy", () => {
    const projection = projectOutgoingUserMessage({
      displayText: "review pasted.txt [paste:paste://1::QQ==]",
    });
    expect(projection.displayContent).toContain("::QQ==");
    expect(projection.agentContent).toBe("review pasted.txt [paste:paste://1]");
  });

  it("projects a canvas pill into the tool contract (agent) and keeps the pill (display)", () => {
    const projection = projectOutgoingUserMessage({
      displayText: "canvas [skill:/canvas] build a coffee order UI",
    });
    expect(projection.displayContent).toBe(
      "canvas [skill:/canvas] build a coffee order UI"
    );
    expect(projection.agentContent).toContain(
      "render_inline_canvas exactly once"
    );
    expect(projection.agentContent).toContain("build a coffee order UI");
    expect(projection.agentContent).not.toContain("[skill:/canvas]");
  });

  it("appends context blocks to the agent copy", () => {
    const projection = projectOutgoingUserMessage({
      displayText: "look at this",
      contextBlocks: ["```\nserver ready\n```"],
    });
    expect(projection.agentContent).toBe(
      "look at this\n\n```\nserver ready\n```"
    );
  });

  it("honors the composer-level interceptor opt-out", () => {
    const projection = projectOutgoingUserMessage({
      displayText: "/canvas build a timer",
      enableAgentInterceptors: false,
    });
    expect(projection.agentContent).toBeUndefined();
  });

  it("honors the canvas capability gate (CLI sessions / attached images)", () => {
    const projection = projectOutgoingUserMessage({
      displayText: "/canvas build a timer",
      allowCanvasInterception: false,
    });
    expect(projection.agentContent).toBeUndefined();
  });
});
