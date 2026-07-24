import { describe, expect, it } from "vitest";

import type { ProviderEndpoint } from "@src/api/tauri/rpc/schemas/validation";

import { resolveSelectedEndpoint } from "./providerEndpoints";

const zhipuEndpoints: ProviderEndpoint[] = [
  {
    id: "global",
    label: "Global API",
    base_url: "https://api.z.ai/api/paas/v4",
    anthropic_base_url: "https://api.z.ai/api/anthropic",
  },
  {
    id: "global-subscription",
    label: "Global Subscription",
    base_url: "https://api.z.ai/api/coding/paas/v4",
    anthropic_base_url: "https://api.z.ai/api/anthropic",
  },
];

describe("resolveSelectedEndpoint", () => {
  it("preserves an explicit endpoint when sibling endpoints share a protocol URL", () => {
    const selected = resolveSelectedEndpoint(
      zhipuEndpoints,
      "https://api.z.ai/api/anthropic",
      "global-subscription"
    );

    expect(selected?.id).toBe("global-subscription");
  });

  it("does not let a stale endpoint id override a custom URL", () => {
    const selected = resolveSelectedEndpoint(
      zhipuEndpoints,
      "https://proxy.example.com",
      "global-subscription"
    );

    expect(selected?.id).toBe("global");
  });
});
