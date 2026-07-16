import { describe, expect, it } from "vitest";

import { BUILTIN_SLASH_ACTION_ITEMS } from "../types";

describe("BUILTIN_SLASH_ACTION_ITEMS", () => {
  it("暴露非空中文内建 slash 指令注册表", () => {
    expect(BUILTIN_SLASH_ACTION_ITEMS.length).toBeGreaterThan(0);
    for (const item of BUILTIN_SLASH_ACTION_ITEMS) {
      expect(item.description).toMatch(/[\u4e00-\u9fff]/);
    }
    const commands = BUILTIN_SLASH_ACTION_ITEMS.map((item) => item.command);
    expect(commands).toContain("/model");
    expect(commands).toContain("/session new");
    expect(commands).toContain("/project new");
  });
});
