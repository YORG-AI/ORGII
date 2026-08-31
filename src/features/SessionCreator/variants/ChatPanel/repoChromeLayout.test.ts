import { describe, expect, it } from "vitest";

import {
  REPO_CHROME_POSITION_CLASS,
  isRepoChromeAboveComposer,
  shouldUseCreatorComposerBreathing,
} from "./repoChromeLayout";

describe("Session Creator repository chrome layout", () => {
  it("places the chrome on the selected side of the composer", () => {
    expect(isRepoChromeAboveComposer("top")).toBe(true);
    expect(isRepoChromeAboveComposer("bottom")).toBe(false);
  });

  it("mirrors the same outer and seam padding in both positions", () => {
    expect(REPO_CHROME_POSITION_CLASS.top).toContain("pt-1.5");
    expect(REPO_CHROME_POSITION_CLASS.top).toContain("pb-2.5");
    expect(REPO_CHROME_POSITION_CLASS.bottom).toContain("pt-2.5");
    expect(REPO_CHROME_POSITION_CLASS.bottom).toContain("pb-1.5");
  });

  it("keeps the launchpad glow away from chrome placed below the composer", () => {
    expect(shouldUseCreatorComposerBreathing(true, "top", true)).toBe(true);
    expect(shouldUseCreatorComposerBreathing(true, "bottom", true)).toBe(false);
    expect(shouldUseCreatorComposerBreathing(false, "top", true)).toBe(false);
    expect(shouldUseCreatorComposerBreathing(true, "bottom", false)).toBe(true);
  });
});
