import { describe, expect, it } from "vitest";

import type { SlashItem } from "@src/types/extensions";

import { buildBuiltinSlashItems } from "../builtinSlashItems";

describe("buildBuiltinSlashItems", () => {
  it("registers Canvas in the shared composer command list", () => {
    const items = buildBuiltinSlashItems({
      canvasDescription: "Create a Canvas",
      compactDescription: "Compact context",
    });

    expect(items[0]).toEqual({
      name: "canvas",
      description: "Create a Canvas",
      category: "action",
      source: "builtin",
      acceptsArgs: true,
    });
    expect(items.map((item) => item.name)).toEqual(["canvas", "compact"]);
  });

  it("omits the canvas action for sessions without the canvas capability", () => {
    const items = buildBuiltinSlashItems({
      canvasDescription: "Create a Canvas",
      compactDescription: "Compact context",
      includeCanvas: false,
    });

    expect(items.map((item) => item.name)).toEqual(["compact"]);
  });

  it("keeps optional contextual commands after stable built-ins", () => {
    const addressItem: SlashItem = {
      name: "address-comments",
      description: "Address review comments",
      category: "action",
      source: "cloud",
      acceptsArgs: true,
    };

    const items = buildBuiltinSlashItems({
      canvasDescription: "Create a Canvas",
      compactDescription: "Compact context",
      addressCommentsItem: addressItem,
    });

    expect(items).toHaveLength(3);
    expect(items[2]).toBe(addressItem);
  });
});
