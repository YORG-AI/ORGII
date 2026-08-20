import { describe, expect, it, vi } from "vitest";

import type { ComposerInputRef } from "@src/components/ComposerInput";

import { prepareLaunchInput } from "./inputPreparation";

vi.mock("@src/util/contextPillContent", () => ({
  waitForPendingPills: vi.fn(async () => undefined),
}));

function composerRef(
  text: string,
  terminalTexts: Record<string, string> = {}
): { current: ComposerInputRef } {
  return {
    current: {
      getTextWithPills: () => text,
      getTerminalPillTexts: () => terminalTexts,
    } as unknown as ComposerInputRef,
  };
}

describe("prepareLaunchInput", () => {
  it("keeps the display serialization as userInput but projects agentInput", async () => {
    const { userInput, agentInput } = await prepareLaunchInput({
      editorContent: "",
      effectiveSource: null,
      composerInputRef: composerRef(
        "canvas [skill:/canvas] build a coffee order UI"
      ),
    });

    // The synthetic user event keeps the pill serialization…
    expect(userInput).toBe("canvas [skill:/canvas] build a coffee order UI");
    // …while the new session's first LLM message is the projected contract,
    // never the raw serialization.
    expect(agentInput).toContain("render_inline_canvas exactly once");
    expect(agentInput).toContain("build a coffee order UI");
    expect(agentInput).not.toContain("[skill:/canvas]");
  });

  it("expands ordinary skill pills for the agent input", async () => {
    const { userInput, agentInput } = await prepareLaunchInput({
      editorContent: "",
      effectiveSource: null,
      composerInputRef: composerRef("statusline [skill:/statusline] please"),
    });

    expect(userInput).toBe("statusline [skill:/statusline] please");
    expect(agentInput).toBe("/statusline please");
  });

  it("returns identical copies for plain text", async () => {
    const { userInput, agentInput } = await prepareLaunchInput({
      editorContent: "",
      effectiveSource: null,
      composerInputRef: composerRef("just launch something"),
    });

    expect(userInput).toBe("just launch something");
    expect(agentInput).toBe("just launch something");
  });

  it("still appends terminal pill blocks to the agent input", async () => {
    const { userInput, agentInput } = await prepareLaunchInput({
      editorContent: "",
      effectiveSource: null,
      composerInputRef: composerRef("look at this", {
        "terminal://1": "server ready",
      }),
    });

    expect(userInput).toBe("look at this");
    expect(agentInput).toBe("look at this\n\n```\nserver ready\n```");
  });

  it("passes /canvas through as ordinary text when the launch targets a CLI agent", async () => {
    const { userInput, agentInput } = await prepareLaunchInput({
      editorContent: "",
      effectiveSource: null,
      composerInputRef: composerRef("/canvas build a timer"),
      allowCanvasInterception: false,
    });

    expect(userInput).toBe("/canvas build a timer");
    expect(agentInput).toBe("/canvas build a timer");
  });
});
