import { describe, expect, it } from "vitest";

import {
  PRODUCT_MODE_PROJECT,
  execModeForComposerSelection,
  resolveSessionAgentExecMode,
} from "./sessionCreatorConfig";

describe("session mode resolution", () => {
  it("does not let the new-session picker leak into an existing session", () => {
    expect(resolveSessionAgentExecMode(null)).toBe("build");
    expect(resolveSessionAgentExecMode("investigate")).toBe("build");
    expect(resolveSessionAgentExecMode("review")).toBe("review");
  });

  it("maps Project onto Build execution without removing product mode", () => {
    expect(PRODUCT_MODE_PROJECT).toBe("project");
    expect(execModeForComposerSelection(PRODUCT_MODE_PROJECT)).toBe("build");
  });
});
