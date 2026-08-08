import { describe, expect, it } from "vitest";

import { normalizeTurnPromptPreview } from "./org2CloudSessionSync";

// Locked mirror of Rust normalize_turn_user_preview (turn_window.rs). If the
// Rust normalization changes, these goldens must change WITH it — a silent
// drift ships different prompts to viewers than the owner's own skeleton.
describe("normalizeTurnPromptPreview", () => {
  it("strips the user_message prefix", () => {
    expect(normalizeTurnPromptPreview("user_message fix the bug")).toBe(
      "fix the bug"
    );
  });

  it("strips the bare user prefix", () => {
    expect(normalizeTurnPromptPreview("user fix the bug")).toBe("fix the bug");
  });

  it("trims without stripping unrelated prefixes", () => {
    expect(normalizeTurnPromptPreview("  username says hi  ")).toBe(
      "username says hi"
    );
  });

  it("caps at 240 chars with a trailing ellipsis", () => {
    const long = "x".repeat(300);
    const normalized = normalizeTurnPromptPreview(long);
    expect(normalized).toHaveLength(241);
    expect(normalized.endsWith("…")).toBe(true);
    expect(normalized.slice(0, 240)).toBe("x".repeat(240));
  });
});
