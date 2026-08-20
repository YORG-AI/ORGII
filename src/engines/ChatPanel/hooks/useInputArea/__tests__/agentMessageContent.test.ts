import { describe, expect, it } from "vitest";

import { resolveAgentMessageContent } from "../agentMessageContent";

describe("resolveAgentMessageContent", () => {
  it("keeps history text intact while projecting a Canvas creation request", () => {
    const displayText =
      "canvas [skill:/canvas] build a settings page with two tabs";

    const agentContent = resolveAgentMessageContent({
      displayText,
      agentBase: "/canvas build a settings page with two tabs",
      hasTransformedPills: true,
      contextBlocks: [],
      enableAgentInterceptors: true,
    });

    expect(displayText).toBe(
      "canvas [skill:/canvas] build a settings page with two tabs"
    );
    expect(agentContent).toContain("render_inline_canvas exactly once");
    expect(agentContent).toContain("build a settings page with two tabs");
    expect(agentContent).not.toContain("[skill:/canvas]");
  });

  it("recognizes the canvas pill mid-text via the display copy", () => {
    // The expanded agent base collapses "prefix + pill" into the bare token;
    // recognition therefore runs on the display text, where the pill is
    // unambiguous anywhere in the draft.
    const agentContent = resolveAgentMessageContent({
      displayText: "make me a timer canvas [skill:/canvas]",
      agentBase: "/canvas",
      hasTransformedPills: true,
      contextBlocks: [],
      enableAgentInterceptors: true,
    });

    expect(agentContent).toContain("render_inline_canvas exactly once");
    expect(agentContent).toContain("make me a timer");
  });

  it("appends context after the resolved Canvas contract", () => {
    const agentContent = resolveAgentMessageContent({
      displayText: "canvas [skill:/canvas] use this terminal output",
      agentBase: "/canvas use this terminal output",
      hasTransformedPills: true,
      contextBlocks: ["```\nserver ready\n```"],
      enableAgentInterceptors: true,
    });

    expect(agentContent).toMatch(
      /\[Canvas Creation Request\][\s\S]+\[User Request\][\s\S]+```\nserver ready\n```/
    );
  });

  it("does not intercept messages when the owning composer opts out", () => {
    expect(
      resolveAgentMessageContent({
        displayText: "/canvas build a timer",
        agentBase: "/canvas build a timer",
        hasTransformedPills: false,
        contextBlocks: [],
        enableAgentInterceptors: false,
      })
    ).toBeUndefined();
  });

  it("passes the command through as ordinary text when canvas interception is disallowed (CLI / images)", () => {
    expect(
      resolveAgentMessageContent({
        displayText: "/canvas build a timer",
        agentBase: "/canvas build a timer",
        hasTransformedPills: false,
        contextBlocks: [],
        enableAgentInterceptors: true,
        allowCanvasInterception: false,
      })
    ).toBeUndefined();

    // The pill form still ships its expanded base (skill pills transformed),
    // just without the contract.
    const agentContent = resolveAgentMessageContent({
      displayText: "canvas [skill:/canvas] build a timer",
      agentBase: "/canvas build a timer",
      hasTransformedPills: true,
      contextBlocks: [],
      enableAgentInterceptors: true,
      allowCanvasInterception: false,
    });
    expect(agentContent).toBe("/canvas build a timer");
  });
});
