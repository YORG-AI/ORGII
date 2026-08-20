import { describe, expect, it } from "vitest";

import {
  canvasSlashCommandNeedsInstruction,
  resolveCanvasSlashAgentContent,
} from "../canvasSlashCommand";

describe("Canvas slash command", () => {
  it("resolves bare, instructed, and multiline typed commands", () => {
    expect(resolveCanvasSlashAgentContent(" /canvas ")).toContain(
      "Ask what they want to build"
    );
    expect(
      resolveCanvasSlashAgentContent("/CANVAS build a coffee order UI")
    ).toContain("build a coffee order UI");
    expect(resolveCanvasSlashAgentContent("/canvas\n第一行\n第二行")).toContain(
      "第一行\n第二行"
    );
  });

  it("does not claim ordinary prose or lookalike commands", () => {
    expect(
      resolveCanvasSlashAgentContent("please use /canvas later")
    ).toBeNull();
    expect(resolveCanvasSlashAgentContent("/canvasish build this")).toBeNull();
    expect(resolveCanvasSlashAgentContent("/canvas/design")).toBeNull();
  });

  it("typed mid-sentence /canvas stays ordinary prose (start-anchored)", () => {
    expect(
      resolveCanvasSlashAgentContent("I think /canvas would be nice")
    ).toBeNull();
  });

  it("recognizes the pill serialization anywhere in the draft", () => {
    // Pill mid-text: the pill only exists because the user picked the
    // command, so surrounding text on either side is the request.
    const content = resolveCanvasSlashAgentContent(
      "please canvas [skill:/canvas] build a timer"
    );
    expect(content).toContain("render_inline_canvas exactly once");
    // Text on both sides of the pill token becomes the request.
    expect(content).toMatch(/\[User Request\]\nplease\s+build a timer/);
    expect(content).not.toContain("[skill:/canvas]");
  });

  it("recognizes the pill with its trailing space deleted", () => {
    const content = resolveCanvasSlashAgentContent(
      "canvas [skill:/canvas]build a timer"
    );
    expect(content).toContain("render_inline_canvas exactly once");
    expect(content).toContain("build a timer");
  });

  it("treats a bare pill as a request-less command", () => {
    const content = resolveCanvasSlashAgentContent("canvas [skill:/canvas]");
    expect(content).toContain("Ask what they want to build");
    expect(content).toContain("Do not call render_inline_canvas yet");
  });

  it("projects the extracted request for the Agent (pills, base64)", () => {
    const content = resolveCanvasSlashAgentContent(
      "canvas [skill:/canvas] style it like snippet [paste:paste://1::QQ==]"
    );
    expect(content).toContain("[paste:paste://1]");
    expect(content).not.toContain("::QQ==");
  });

  it("resolves an instructed command to the creation tool contract", () => {
    const content = resolveCanvasSlashAgentContent(
      "/canvas build a stateful timer"
    );

    expect(content).toContain("render_inline_canvas exactly once");
    expect(content).toContain("new Canvas rather than an edit");
    expect(content).toContain("build a stateful timer");
  });

  it("leaves unrelated messages unchanged", () => {
    expect(resolveCanvasSlashAgentContent("draw a canvas bag")).toBeNull();
  });

  describe("canvasSlashCommandNeedsInstruction", () => {
    it("is true for a bare command (typed or pill)", () => {
      expect(canvasSlashCommandNeedsInstruction("/canvas")).toBe(true);
      expect(canvasSlashCommandNeedsInstruction("canvas [skill:/canvas]")).toBe(
        true
      );
    });

    it("is false once a request exists or for non-commands", () => {
      expect(canvasSlashCommandNeedsInstruction("/canvas build it")).toBe(
        false
      );
      expect(
        canvasSlashCommandNeedsInstruction("canvas [skill:/canvas] build it")
      ).toBe(false);
      expect(canvasSlashCommandNeedsInstruction("ordinary text")).toBe(false);
    });
  });
});
