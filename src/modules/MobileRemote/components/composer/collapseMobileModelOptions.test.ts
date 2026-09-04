// @vitest-environment node
import { describe, expect, it } from "vitest";

import type { MobileModelOption } from "@src/modules/MobileRemote/connection/types";

import {
  collapseMobileModelOptions,
  mobileModelOptionsShareFamily,
} from "./collapseMobileModelOptions";

const account = "acct-1";

function option(id: string): MobileModelOption {
  return { id, accountId: account, accountLabel: "Anthropic" };
}

describe("collapseMobileModelOptions", () => {
  it("keeps one row per model family", () => {
    const collapsed = collapseMobileModelOptions([
      option("gpt-5.6-sol"),
      option("gpt-5.6-sol-low"),
      option("gpt-5.6-sol-medium"),
      option("gpt-5.6-sol-high"),
      option("gpt-5.6-sol-max"),
      option("claude-sonnet-4-5"),
      option("claude-opus-4-5"),
    ]);

    expect(collapsed.map((row) => row.id).sort()).toEqual([
      "claude-opus-4-5",
      "claude-sonnet-4-5",
      "gpt-5.6-sol-medium",
    ]);
  });

  it("collapses cursor-hosted grok variants to one row per family", () => {
    const collapsed = collapseMobileModelOptions([
      option("cursor-grok-4.6-high-fast"),
      option("cursor-grok-4.6-medium"),
      option("cursor-grok-4.6-high"),
      option("cursor-grok-4.6-xhigh"),
      option("composer-2.5"),
      option("composer-2.5-fast"),
    ]);

    expect(collapsed.map((row) => row.id).sort()).toEqual([
      "composer-2.5-fast",
      "cursor-grok-4.6-medium",
    ]);
  });
});

describe("mobileModelOptionsShareFamily", () => {
  it("matches effort variants in the same family", () => {
    const options = [
      option("gpt-5.6-sol-max"),
      option("gpt-5.6-sol-medium"),
      option("claude-sonnet-4-5"),
    ];
    expect(
      mobileModelOptionsShareFamily(
        options,
        "gpt-5.6-sol-max",
        "gpt-5.6-sol-medium"
      )
    ).toBe(true);
    expect(
      mobileModelOptionsShareFamily(
        options,
        "gpt-5.6-sol-max",
        "claude-sonnet-4-5"
      )
    ).toBe(false);
  });

  it("matches cursor-hosted grok effort variants", () => {
    const options = [
      option("cursor-grok-4.6-high-fast"),
      option("cursor-grok-4.6-medium"),
    ];
    expect(
      mobileModelOptionsShareFamily(
        options,
        "cursor-grok-4.6-high-fast",
        "cursor-grok-4.6-medium"
      )
    ).toBe(true);
  });
});
