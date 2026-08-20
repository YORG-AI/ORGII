import { describe, expect, it } from "vitest";

import { ICON_MAP, THEMEABLE_ICONS } from "./config";

describe("OpenAI icon consolidation", () => {
  it("uses the shared OpenAI icon for OpenAI and Codex models", () => {
    expect(ICON_MAP.codex).toBe(ICON_MAP.openai);
  });

  it("renders both OpenAI icon identities with theme colors", () => {
    expect(THEMEABLE_ICONS.has("openai")).toBe(true);
    expect(THEMEABLE_ICONS.has("codex")).toBe(true);
  });
});
