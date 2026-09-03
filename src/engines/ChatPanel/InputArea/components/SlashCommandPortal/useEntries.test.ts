import { describe, expect, it } from "vitest";

import type { PinnedAction } from "@src/store/session/pinnedActionsAtom";
import type { SlashItem } from "@src/types/extensions";

import { buildSkillEntries } from "./useEntries";

const item = (
  name: string,
  category: SlashItem["category"],
  skillScope?: SlashItem["skillScope"]
): SlashItem => ({
  name,
  category,
  description: `${name} description`,
  source: "builtin",
  acceptsArgs: false,
  skillScope,
});

describe("buildSkillEntries", () => {
  it("keeps / skills-only even when action and tool rows are supplied", () => {
    const { entries, totalFlat } = buildSkillEntries(
      [
        item("workspace-skill", "skill", "workspace"),
        item("user-skill", "skill", "user"),
        item("action-row", "action"),
        item("tool-row", "tool"),
      ],
      ""
    );

    const itemEntries = entries.filter((entry) => entry.kind === "item");
    expect(itemEntries.map((entry) => entry.item.name)).toEqual([
      "workspace-skill",
      "user-skill",
    ]);
    expect(totalFlat).toBe(2);
  });

  it("projects persisted skill pins first without duplicating their scope rows", () => {
    const workspaceSkill = {
      ...item("Workspace display name", "skill", "workspace"),
      skillName: "workspace-token",
    };
    const userSkill = item("user-skill", "skill", "user");
    const pinnedActions: PinnedAction[] = [
      {
        name: "Older display name",
        skillName: "workspace-token",
        category: "skill",
        source: "renamed-source",
      },
      {
        name: "Duplicate legacy pin",
        skillName: "workspace-token",
        category: "skill",
        source: "another-old-source",
      },
      {
        name: "ignored-action",
        category: "action",
        source: "builtin",
      },
    ];

    const { entries, totalFlat } = buildSkillEntries(
      [workspaceSkill, userSkill],
      "",
      pinnedActions
    );

    expect(entries).toMatchObject([
      {
        kind: "header",
        label: "Pinned",
        translationKey: "common:selectors.repo.sections.pinned",
      },
      { kind: "item", item: { name: "Workspace display name" } },
      { kind: "divider" },
      { kind: "header", label: "User Skills" },
      { kind: "item", item: { name: "user-skill" } },
    ]);
    expect(totalFlat).toBe(2);
  });

  it("keeps pinned skills searchable from the composer-owned query", () => {
    const pinnedSkill = item("canvas-helper", "skill", "user");
    const pinnedActions: PinnedAction[] = [
      {
        name: pinnedSkill.name,
        category: "skill",
        source: pinnedSkill.source,
      },
    ];

    const { entries } = buildSkillEntries(
      [pinnedSkill, item("review-helper", "skill", "workspace")],
      "review",
      pinnedActions
    );

    expect(
      entries
        .filter((entry) => entry.kind === "item")
        .map((entry) => entry.item.name)
    ).toEqual(["review-helper"]);
  });
});
