import { describe, expect, it } from "vitest";

import { normalizeUserMessageText } from "../normalizeUserMessageText";

describe("normalizeUserMessageText", () => {
  it("removes a heading-only files section", () => {
    expect(normalizeUserMessageText("# Files mentioned by the user:")).toBe("");
    expect(
      normalizeUserMessageText("# Files mentioned by the user:\n\n   ")
    ).toBe("");
    expect(
      normalizeUserMessageText("\n\n# Files mentioned by the user:\n")
    ).toBe("");
    expect(
      normalizeUserMessageText("\u200B# Files mentioned by the user:\n")
    ).toBe("");
    expect(
      normalizeUserMessageText("\u200B\n# Files mentioned by the user:\n")
    ).toBe("");
  });

  it("removes the heading and leading blank lines when content follows", () => {
    expect(
      normalizeUserMessageText(
        "# Files mentioned by the user:\n\nreport.pdf [file:/tmp/report.pdf]"
      )
    ).toBe("report.pdf [file:/tmp/report.pdf]");
  });

  it("leaves ordinary user text unchanged", () => {
    const text = "# Review this file\nKeep the heading.";
    expect(normalizeUserMessageText(text)).toBe(text);
    expect(normalizeUserMessageText("\n\nKeep intentional spacing.")).toBe(
      "\n\nKeep intentional spacing."
    );
  });
});
