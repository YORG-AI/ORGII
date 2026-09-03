import { describe, expect, it } from "vitest";

import {
  buildSettingsNavigationGroups,
  getActiveSettingsNavigationItemId,
} from "./settingsNavigation";

const translate = (key: string) => key;

describe("settingsNavigation", () => {
  it("builds the canonical sidebar order from one navigation model", () => {
    const groups = buildSettingsNavigationGroups(translate, true);

    expect(
      groups.map((group) => ({
        id: group.id,
        items: group.items.map((item) => item.id),
      }))
    ).toEqual([
      {
        id: "app",
        items: ["general", "collaboration", "appearance", "editor", "monitor"],
      },
      {
        id: "core",
        items: [
          "agent-orgs",
          "models",
          "myRoles",
          "rulesMemoryEvolution",
          "security",
          "routines",
        ],
      },
      {
        id: "tools",
        items: ["tools", "computerUse", "externalSkillsets", "devtools"],
      },
      {
        id: "connections",
        items: ["connections", "git", "databases", "housekeeper"],
      },
    ]);

    const allIds = groups.flatMap((group) =>
      group.items.map((item) => item.id)
    );
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it("derives labels, icons, routes, and dev-mode visibility for consumers", () => {
    const groups = buildSettingsNavigationGroups(translate, false);
    const items = groups.flatMap((group) => group.items);

    expect(items.some((item) => item.id === "tools")).toBe(false);
    expect(items.find((item) => item.id === "general")).toMatchObject({
      label: "settings:sections.general",
      path: "/orgii/app/settings/app/general",
      groupId: "app",
      dataTestId: "settings-core-item-general",
    });
    expect(items.find((item) => item.id === "agent-orgs")).toMatchObject({
      label: "navigation:labels.agentOrgs",
      path: "/orgii/app/settings/agent-orgs/agents",
      groupId: "core",
    });
    expect(
      items.find((item) => item.id === "rulesMemoryEvolution")
    ).toMatchObject({
      label: "settings:coreSidebar.items.rulesMemoryEvolution",
      path: "/orgii/app/settings/integrations/rules-memory-and-evolution",
    });
    expect(items.every((item) => item.icon)).toBe(true);
  });

  it("resolves the active navigation item from every settings route family", () => {
    expect(
      getActiveSettingsNavigationItemId("/orgii/app/settings/app/appearance")
    ).toBe("appearance");
    expect(
      getActiveSettingsNavigationItemId(
        "/orgii/app/settings/integrations/skills-mcps-plugins"
      )
    ).toBe("externalSkillsets");
    expect(
      getActiveSettingsNavigationItemId("/orgii/app/settings/agent-orgs/orgs")
    ).toBe("agent-orgs");
    expect(getActiveSettingsNavigationItemId("/orgii/app/settings")).toBe(
      "general"
    );
  });
});
