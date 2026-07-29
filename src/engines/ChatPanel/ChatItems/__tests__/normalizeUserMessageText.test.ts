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

  it("removes the heading and preserves native pill tokens", () => {
    expect(
      normalizeUserMessageText(
        "# Files mentioned by the user:\n\nreport.pdf [file:/tmp/report.pdf]"
      )
    ).toBe("report.pdf [file:/tmp/report.pdf]");
  });

  it("converts Codex attachment entries to native file pills", () => {
    expect(
      normalizeUserMessageText(
        [
          "# Files mentioned by the user:",
          "",
          "## Screenshot 2026-07-29 at 6.56 PM.png: /tmp/Screenshot 2026-07-29.png",
          "",
          "## pasted output: C:\\Users\\me\\pasted-text.txt",
          "",
          "## My request for Codex:",
          "Review these files.",
        ].join("\n")
      )
    ).toBe(
      [
        "Screenshot-2026-07-29-at-6.56-PM.png [file:/tmp/Screenshot 2026-07-29.png]",
        "",
        "pasted-output [file:C:\\Users\\me\\pasted-text.txt]",
        "",
        "Review these files.",
      ].join("\n")
    );
  });

  it("uses a folder pill for a generated attachment path ending in a slash", () => {
    expect(
      normalizeUserMessageText(
        "# Files mentioned by the user:\n\n## fixtures: /repo/fixtures/\n"
      )
    ).toBe("fixtures [folder:/repo/fixtures/]");
  });

  it("removes a generated image file entry when native image metadata exists", () => {
    const imagePath = "/tmp/Screenshot 2026-07-29.png";
    expect(
      normalizeUserMessageText(
        [
          "# Files mentioned by the user:",
          "",
          `## Screenshot.png: ${imagePath}`,
          "",
          "## My request for Codex:",
          "Inspect it.",
        ].join("\n"),
        [`https://asset.localhost${encodeURI(imagePath)}`]
      )
    ).toBe("Inspect it.");
  });

  it("leaves ordinary user text unchanged", () => {
    const text = "# Review this file\nKeep the heading.";
    expect(normalizeUserMessageText(text)).toBe(text);
    expect(normalizeUserMessageText("\n\nKeep intentional spacing.")).toBe(
      "\n\nKeep intentional spacing."
    );
  });
});
