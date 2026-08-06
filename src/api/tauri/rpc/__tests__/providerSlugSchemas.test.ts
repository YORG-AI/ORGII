import { describe, expect, it } from "vitest";

import {
  ModelSlugInfoSchema,
  SaveKeyRequestSchema,
  ZENMUX_PROVIDER_SLUGS,
} from "../schemas/validation";

describe("ZenMux provider slug schemas", () => {
  it("defaults provider slug persistence to absent and accepts the supported UI values", () => {
    const withoutSlugs = SaveKeyRequestSchema.parse({
      agent_type: "zenmux_api",
    });
    expect(withoutSlugs.model_slugs).toBeUndefined();

    for (const slug of ZENMUX_PROVIDER_SLUGS) {
      expect(
        ModelSlugInfoSchema.parse({
          model: "anthropic/claude-opus-4.8",
          slug,
        })
      ).toEqual({ model: "anthropic/claude-opus-4.8", slug });
    }
  });

  it("rejects provider values outside the selectable list", () => {
    expect(() =>
      ModelSlugInfoSchema.parse({
        model: "anthropic/claude-opus-4.8",
        slug: "unknown-provider",
      })
    ).toThrow();
  });
});
