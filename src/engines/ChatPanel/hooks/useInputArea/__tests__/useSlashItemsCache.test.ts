import { describe, expect, it } from "vitest";

import type { SlashItem } from "@src/types/extensions";

import {
  buildSlashItemsScopeKey,
  dedupeSkillItemsAgainstBuiltins,
} from "../useSlashItemsCache";

const canvasBuiltin: SlashItem = {
  name: "canvas",
  description: "Create a Canvas",
  category: "action",
  source: "builtin",
  acceptsArgs: true,
};

const compactBuiltin: SlashItem = {
  name: "compact",
  description: "Compact context",
  category: "action",
  source: "builtin",
  acceptsArgs: true,
};

function skill(name: string, skillName = name): SlashItem {
  return {
    name,
    skillName,
    skillPath: `/home/user/.orgii/skills/${skillName}`,
    description: "",
    category: "skill",
    source: "ORGII Skills",
    acceptsArgs: false,
    skillScope: "user",
  };
}

describe("dedupeSkillItemsAgainstBuiltins", () => {
  it("drops user skills whose name collides with a builtin action", () => {
    const result = dedupeSkillItemsAgainstBuiltins(
      [canvasBuiltin, compactBuiltin],
      [skill("canvas"), skill("statusline")]
    );
    expect(result.map((item) => item.name)).toEqual(["statusline"]);
  });

  it("compares case-insensitively and against the slash token too", () => {
    const result = dedupeSkillItemsAgainstBuiltins(
      [canvasBuiltin],
      [skill("Canvas"), skill("My canvas", "canvas"), skill("canvassing")]
    );
    // "canvassing" is a different token — it stays.
    expect(result.map((item) => item.name)).toEqual(["canvassing"]);
  });

  it("keeps a colliding skill when the builtin is absent (e.g. CLI sessions)", () => {
    const result = dedupeSkillItemsAgainstBuiltins(
      [compactBuiltin],
      [skill("canvas")]
    );
    expect(result.map((item) => item.name)).toEqual(["canvas"]);
  });

  it("never reserves against non-action builtins", () => {
    const result = dedupeSkillItemsAgainstBuiltins(
      [{ ...canvasBuiltin, category: "tool", serverName: "srv" }],
      [skill("canvas")]
    );
    expect(result.map((item) => item.name)).toEqual(["canvas"]);
  });
});

describe("buildSlashItemsScopeKey", () => {
  it("discriminates identical workspace scopes by builtin set", () => {
    const withCanvas = buildSlashItemsScopeKey("/repo", [
      canvasBuiltin,
      compactBuiltin,
    ]);
    const withoutCanvas = buildSlashItemsScopeKey("/repo", [compactBuiltin]);
    expect(withCanvas).not.toBe(withoutCanvas);
  });

  it("is stable for the same inputs and varies by workspace scope", () => {
    expect(buildSlashItemsScopeKey("/repo", [canvasBuiltin])).toBe(
      buildSlashItemsScopeKey("/repo", [canvasBuiltin])
    );
    expect(buildSlashItemsScopeKey("/repo-a", [canvasBuiltin])).not.toBe(
      buildSlashItemsScopeKey("/repo-b", [canvasBuiltin])
    );
  });
});
