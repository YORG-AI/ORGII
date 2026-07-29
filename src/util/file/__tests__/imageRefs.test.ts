import { describe, expect, it } from "vitest";

import { imageRefToRustPath } from "../imageRefs";

describe("imageRefToRustPath", () => {
  it.each([
    ["asset://localhost/tmp/Screenshot%202026.png", "/tmp/Screenshot 2026.png"],
    [
      "https://asset.localhost/tmp/Screenshot%202026.png",
      "/tmp/Screenshot 2026.png",
    ],
    ["http://asset.localhost/C%3A/Users/me/image.png", "C:/Users/me/image.png"],
  ])("decodes Tauri asset reference %s", (reference, expected) => {
    expect(imageRefToRustPath(reference)).toBe(expected);
  });

  it("leaves data URLs and plain paths unchanged", () => {
    expect(imageRefToRustPath("data:image/png;base64,c21hbGw=")).toBe(
      "data:image/png;base64,c21hbGw="
    );
    expect(imageRefToRustPath("/tmp/image.png")).toBe("/tmp/image.png");
  });

  it("leaves malformed asset URLs unchanged", () => {
    const malformedRef = "asset://localhost/tmp/bad%2";
    expect(imageRefToRustPath(malformedRef)).toBe(malformedRef);
  });
});
