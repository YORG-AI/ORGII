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
