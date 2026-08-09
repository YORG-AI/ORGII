import { describe, expect, it } from "vitest";

import { REGISTRY } from "./registry";

describe("project-tree workstation registration", () => {
  it("registers the dedicated project-tree renderer", () => {
    expect(REGISTRY["project-tree"].debugLabel).toBe("project-tree");
  });
});
