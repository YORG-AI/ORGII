import { describe, expect, it } from "vitest";

import {
  AGENT_COMPOSER_PREFIX,
  detectAgentPrefix,
  shouldShowAgentSuggestion,
  splitAgentMentionBody,
} from "./commentAgentAffordances";

describe("agent composer suggestion", () => {
  it("offers the canonical target while typing its prefix", () => {
    expect(shouldShowAgentSuggestion("@")).toBe(true);
    expect(shouldShowAgentSuggestion("@a")).toBe(true);
    expect(shouldShowAgentSuggestion("@agent")).toBe(true);
  });

  it("closes for empty, diverged, or already completed input", () => {
    expect(shouldShowAgentSuggestion("")).toBe(false);
    expect(shouldShowAgentSuggestion("@other")).toBe(false);
    expect(shouldShowAgentSuggestion("@agent ")).toBe(false);
    expect(shouldShowAgentSuggestion("@agent fix")).toBe(false);
  });
});

describe("detectAgentPrefix — literal, deterministic (design §1: no NL)", () => {
  it("matches the exact prefix followed by content", () => {
    expect(detectAgentPrefix("@agent fix the null check")).toBe(true);
    expect(detectAgentPrefix("@agent  double space still counts")).toBe(true);
  });

  it("the trailing space is part of the token", () => {
    expect(detectAgentPrefix("@agent")).toBe(false);
    expect(detectAgentPrefix("@agents please")).toBe(false);
    expect(detectAgentPrefix("@agent.")).toBe(false);
  });

  it("requires content after the prefix (comments post VERBATIM)", () => {
    expect(detectAgentPrefix("@agent ")).toBe(false);
    expect(detectAgentPrefix("@agent   ")).toBe(false);
  });

  it("is case-sensitive and anchored at index 0", () => {
    expect(detectAgentPrefix("@Agent fix")).toBe(false);
    expect(detectAgentPrefix("hey @agent fix")).toBe(false);
    // Composers trim before submit; the raw detector stays literal.
    expect(detectAgentPrefix(" @agent fix")).toBe(false);
  });

  it("exports the literal token the composer placeholder documents", () => {
    expect(AGENT_COMPOSER_PREFIX).toBe("@agent ");
  });
});

describe("splitAgentMentionBody — rendered mention token", () => {
  it("returns the canonical pill label and preserves the submitted brief", () => {
    expect(splitAgentMentionBody("@agent fix the null check")).toEqual({
      mention: "@agent",
      brief: "fix the null check",
    });
    expect(splitAgentMentionBody("@agent  preserve spacing")).toEqual({
      mention: "@agent",
      brief: " preserve spacing",
    });
  });

  it("does not tokenize ordinary inline or incomplete text", () => {
    expect(splitAgentMentionBody("hello @agent fix this")).toBeNull();
    expect(splitAgentMentionBody("@agent ")).toBeNull();
  });
});
