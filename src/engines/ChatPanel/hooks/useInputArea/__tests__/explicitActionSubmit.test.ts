import { describe, expect, it } from "vitest";

import { resolveSubmitInput } from "../useSubmitMessage";

describe("resolveSubmitInput", () => {
  it("isolates an explicit action from the live draft and attachments", () => {
    expect(
      resolveSubmitInput(
        {
          capturedText: "Run the targeted checks.",
          source: "explicit-action",
        },
        "Keep this unsent draft",
        true
      )
    ).toEqual({
      isExplicitAction: true,
      displayText: "Run the targeted checks.",
      hasAttachedImages: false,
    });
  });

  it("keeps ordinary editor submissions on the existing live-input path", () => {
    expect(
      resolveSubmitInput(
        { capturedText: "captured fallback", source: "editor" },
        "Live editor text",
        true
      )
    ).toEqual({
      isExplicitAction: false,
      displayText: "Live editor text",
      hasAttachedImages: true,
    });
  });
});
