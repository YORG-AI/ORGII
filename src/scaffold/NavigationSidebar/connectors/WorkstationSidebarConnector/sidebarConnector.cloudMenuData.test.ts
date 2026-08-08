import { describe, expect, it } from "vitest";

import type { NavigationMenuItem } from "@src/scaffold/NavigationSidebar/components/NavigationMenu/config";

import { mergeCloudSidebarSections } from "./sidebarConnector.cloudMenuData";

describe("mergeCloudSidebarSections", () => {
  it("places team channels above team conversations", () => {
    const channels: NavigationMenuItem[] = [
      {
        id: "separator-cloud-channels",
        key: "separator-cloud-channels",
        label: "Channels",
      },
      { id: "cloud-channel-1", key: "cloud-channel-1", label: "general" },
    ];
    const conversations: NavigationMenuItem[] = [
      {
        id: "separator-cloud-team-sessions",
        key: "separator-cloud-team-sessions",
        label: "Team conversations",
      },
      {
        id: "cloud-session-1",
        key: "cloud-session-1",
        label: "Conversation",
      },
    ];

    expect(mergeCloudSidebarSections(channels, conversations)).toEqual([
      ...channels,
      ...conversations,
    ]);
  });

  it("keeps team conversations unchanged when channels are unavailable", () => {
    const conversations: NavigationMenuItem[] = [
      {
        id: "separator-cloud-team-sessions",
        key: "separator-cloud-team-sessions",
        label: "Team conversations",
      },
    ];

    expect(mergeCloudSidebarSections([], conversations)).toEqual(conversations);
  });
});
