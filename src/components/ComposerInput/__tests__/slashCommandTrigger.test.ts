import { describe, expect, it } from "vitest";

import { canStartSlashCommand } from "../keyboard";

describe("canStartSlashCommand", () => {
  it("allows slash commands at the start of input", () => {
    expect(canStartSlashCommand("/skill", 0)).toBe(true);
  });

  it("allows slash commands after whitespace", () => {
    expect(canStartSlashCommand("run /skill", 4)).toBe(true);
    expect(canStartSlashCommand("run\n/skill", 4)).toBe(true);
  });

  it("ignores slash characters inside path-like text", () => {
    expect(canStartSlashCommand("github/x/y", 6)).toBe(false);
    expect(canStartSlashCommand("https://github.com/org2ai/ORG2", 6)).toBe(
      false
    );
  });
});
