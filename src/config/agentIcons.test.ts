import { describe, expect, it } from "vitest";

import { AiProgrammingIcon } from "@src/icons";

import { resolveAgentIcon } from "./agentIcons";

describe("resolveAgentIcon", () => {
  it("resolves the SDE Agent slug to the programming glyph", () => {
    expect(resolveAgentIcon("ai-programming")).toBe(AiProgrammingIcon);
  });
});
