import { describe, expect, it } from "vitest";

import { describeModelLabel } from "@src/engines/ChatPanel/ChatItems/rawPromptModelLabel";

describe("describeModelLabel", () => {
  it("splits Anthropic effort out of the id formatter drops it from", () => {
    // formatModelNameFull("claude-opus-4-7-thinking-xhigh") is just "Opus 4.7":
    // without this split the effort would be invisible.
    expect(describeModelLabel("claude-opus-4-7-thinking-xhigh")).toEqual({
      name: "Opus 4.7",
      variant: "Extra High · Thinking",
    });
  });

  it("does not duplicate GPT effort the id formatter already keeps", () => {
    // formatModelNameFull("gpt-5.3-codex-high") is "GPT 5.3 Codex High";
    // naive appending would read "GPT 5.3 Codex High · High".
    expect(describeModelLabel("gpt-5.3-codex-high")).toEqual({
      name: "GPT 5.3 Codex",
      variant: "High",
    });
  });

  it("reports thinking with no reasoning level", () => {
    expect(describeModelLabel("claude-sonnet-4-5-thinking")).toEqual({
      name: "Sonnet 4.5",
      variant: "Thinking",
    });
  });

  it("reports the fast dimension", () => {
    expect(describeModelLabel("composer-1-fast")).toEqual({
      name: "Composer 1",
      variant: "Fast",
    });
  });

  it("leaves a plain dated model id with no variant", () => {
    expect(describeModelLabel("claude-opus-4.5-20251219")).toEqual({
      name: "Opus 4.5 20251219",
      variant: "",
    });
  });

  it("leaves a non-variant provider id alone", () => {
    expect(describeModelLabel("gemini-2.0-flash")).toEqual({
      name: "Gemini 2.0 Flash",
      variant: "",
    });
  });

  it("formats the whole id when no variant label survives", () => {
    // Guards the base-model shortcut: an id whose suffix parses but yields no
    // displayable segment must not lose that suffix from the name.
    const label = describeModelLabel("gpt-5.3-codex-minimal");
    expect(label?.variant).toBe("");
    expect(label?.name).toContain("Minimal");
  });

  it("returns null for a missing or blank model", () => {
    expect(describeModelLabel(undefined)).toBeNull();
    expect(describeModelLabel(null)).toBeNull();
    expect(describeModelLabel("   ")).toBeNull();
  });
});
