import { describe, expect, it } from "vitest";

import { extensionForOptimizedImage } from "./useWorkItemImageInsert";

describe("extensionForOptimizedImage", () => {
  it("uses the optimized payload MIME when an animated GIF is flattened", () => {
    expect(
      extensionForOptimizedImage("data:image/jpeg;base64,AA==", "image/gif")
    ).toBe("jpg");
  });

  it("falls back to the source MIME when the payload has no data URL header", () => {
    expect(extensionForOptimizedImage("invalid", "image/gif")).toBe("gif");
  });
});
