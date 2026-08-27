import { describe, expect, it } from "vitest";

import { normalizePlaceholderSubtitle } from "./normalizePlaceholderSubtitle";

describe("shared normalizePlaceholderSubtitle", () => {
  it.each([
    ["This file is not displayed.", "This file is not displayed"],
    ["该文件未显示。", "该文件未显示"],
    ["該文件未顯示。。。", "該文件未顯示"],
  ])("removes a final sentence period from %j", (subtitle, expected) => {
    expect(normalizePlaceholderSubtitle(subtitle)).toBe(expected);
  });

  it("preserves an intentional progress ellipsis", () => {
    expect(normalizePlaceholderSubtitle("Opening database...")).toBe(
      "Opening database..."
    );
  });

  it.each(["Try again!", "What happened?"])(
    "preserves other terminal punctuation in %j",
    (subtitle) => {
      expect(normalizePlaceholderSubtitle(subtitle)).toBe(subtitle);
    }
  );

  it("keeps absent subtitles absent", () => {
    expect(normalizePlaceholderSubtitle(undefined)).toBeUndefined();
  });
});
