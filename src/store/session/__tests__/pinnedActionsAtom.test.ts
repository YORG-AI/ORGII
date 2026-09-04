import { describe, expect, it } from "vitest";

import {
  getPinnedActionKey,
  slashItemToPinnedAction,
} from "../pinnedActionsAtom";

describe("pinned action identity", () => {
  it("matches a persisted skill after its display source and name change", () => {
    const persisted = {
      name: "Old label",
      skillName: "review-code",
      category: "skill" as const,
      source: "Old group",
    };
    const discovered = {
      name: "Review code",
      skillName: "review-code",
      category: "skill" as const,
      source: "Workspace Skills",
      description: "Review a change",
      acceptsArgs: false,
    };

    expect(getPinnedActionKey(persisted)).toBe(getPinnedActionKey(discovered));
  });

  it("keeps same-named tools from different MCP servers distinct", () => {
    expect(
      getPinnedActionKey({
        name: "search",
        category: "tool",
        source: "server-a",
        serverName: "server-a",
      })
    ).not.toBe(
      getPinnedActionKey({
        name: "search",
        category: "tool",
        source: "server-b",
        serverName: "server-b",
      })
    );
  });

  it("snapshots the fields needed to restore an available skill pin", () => {
    expect(
      slashItemToPinnedAction({
        name: "Review code",
        skillName: "review-code",
        skillPath: "/repo/.codex/skills/review-code",
        category: "skill",
        source: "Workspace Skills",
        description: "Review a change",
        acceptsArgs: false,
      })
    ).toEqual({
      name: "Review code",
      skillName: "review-code",
      skillPath: "/repo/.codex/skills/review-code",
      category: "skill",
      source: "Workspace Skills",
      serverName: undefined,
    });
  });
});
