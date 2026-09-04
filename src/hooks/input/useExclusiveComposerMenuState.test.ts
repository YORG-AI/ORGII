import { describe, expect, it } from "vitest";

import { resolveComposerMenuVisibility } from "./useExclusiveComposerMenuState";

describe("resolveComposerMenuVisibility", () => {
  it("closes context when slash opens and closes slash when context opens", () => {
    expect(resolveComposerMenuVisibility("context", "slash", true)).toBe(
      "slash"
    );
    expect(resolveComposerMenuVisibility("slash", "context", true)).toBe(
      "context"
    );
  });

  it("does not close the active menu when a stale close targets the other one", () => {
    expect(resolveComposerMenuVisibility("slash", "context", false)).toBe(
      "slash"
    );
    expect(resolveComposerMenuVisibility("context", "slash", false)).toBe(
      "context"
    );
  });
});
