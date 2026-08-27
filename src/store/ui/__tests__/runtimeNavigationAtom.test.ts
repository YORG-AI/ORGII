import { describe, expect, it } from "vitest";

import { createRuntimeScanningNavigationIntent } from "../runtimeNavigationAtom";

describe("createRuntimeScanningNavigationIntent", () => {
  it("targets the personal Scanning tab", () => {
    const intent = createRuntimeScanningNavigationIntent();

    expect(intent.scope).toBe("personal");
    expect(intent.view).toBe("scanning");
  });

  it("issues a fresh request id per navigation so a repeat click is not ignored", () => {
    const first = createRuntimeScanningNavigationIntent();
    const second = createRuntimeScanningNavigationIntent();

    // The panel drops an intent whose id it already consumed, so two clicks in
    // the same millisecond must still produce two distinct requests.
    expect(second.requestId).toBeGreaterThan(first.requestId);
  });
});
