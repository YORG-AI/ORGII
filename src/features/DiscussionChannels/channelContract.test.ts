import { describe, expect, it } from "vitest";

import {
  CHANNEL_NAME_MAX_LENGTH,
  normalizeChannelName,
  normalizeChannelNameInput,
  validateChannelName,
} from "./channelContract";

describe("channel name normalization", () => {
  it("lowercases, strips leading #, and hyphenates whitespace while typing", () => {
    expect(normalizeChannelNameInput("#Code Review")).toBe("code-review");
    expect(normalizeChannelNameInput("##General")).toBe("general");
    expect(normalizeChannelNameInput("a  b\tc")).toBe("a-b-c");
  });

  it("caps live input at the server bound", () => {
    const raw = "x".repeat(CHANNEL_NAME_MAX_LENGTH + 20);
    expect(normalizeChannelNameInput(raw)).toHaveLength(
      CHANNEL_NAME_MAX_LENGTH
    );
  });

  it("drops edge hyphens left by typing on submit", () => {
    expect(normalizeChannelName("  release notes  ")).toBe("release-notes");
    expect(normalizeChannelName("-hotfix-branch-")).toBe("hotfix-branch");
  });

  it("keeps non-latin names intact (unicode channel names are allowed)", () => {
    expect(normalizeChannelName("代码评审")).toBe("代码评审");
  });

  it("validates the normalized form against the 0014 contract", () => {
    expect(validateChannelName("")).toBe("empty");
    expect(validateChannelName("x".repeat(CHANNEL_NAME_MAX_LENGTH + 1))).toBe(
      "tooLong"
    );
    expect(validateChannelName("has space")).toBe("whitespace");
    expect(validateChannelName("release-notes")).toBeNull();
  });
});
