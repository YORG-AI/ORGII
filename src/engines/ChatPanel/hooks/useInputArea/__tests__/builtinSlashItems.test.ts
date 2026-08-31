import { describe, expect, it } from "vitest";

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
});
